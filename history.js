// ===== 変更履歴（change_log への記録・閲覧） =====
// 全体工程表・組立工程表・設計工程表と共有の change_log テーブルに、
// source = '操業工程表' として書き込む。change_log は SELECT/INSERT のみ許可されており
// UPDATE/DELETE の権限が無いため、同一タスク・同一項目への連続した変更は
// 一定時間（HISTORY_MERGE_WINDOW_MS）書き込みを保留してまとめてから1件だけ INSERT する。
const HISTORY_SOURCE = '操業工程表';
const HISTORY_MERGE_WINDOW_MS = 5000;

const HISTORY_FIELDS = [
    { key: 'text',             label: 'タスク名' },
    { key: 'project_number',   label: '工事番号' },
    { key: 'machine',          label: '機械' },
    { key: 'unit',             label: 'ユニット' },
    { key: 'owner',            label: '担当者' },
    { key: 'status',           label: '進捗' },
    { key: 'start_date',       label: '開始日' },
    { key: 'end_date',         label: '終了日' },
    { key: 'notes',            label: 'メモ' },
    { key: 'is_business_trip', label: '出張予定' }
];

const _TASK_TYPE_HISTORY_LABELS = { planning: '計画', operation: '社内試運転', business_trip: '出張' };

// change_log に「タブ」列が無いため、description の先頭に [タブ名] を埋め込んで記録し、
// 一覧表示側（_renderHistoryTable）で切り出して専用列に表示する
function _taskModeLabel(task) {
    if (!task) return '';
    const isBT = task.is_business_trip === true || String(task.is_business_trip).toUpperCase() === 'TRUE';
    if (isBT) return '出張';
    const norm = (typeof _normalizeTaskTypeForDb === 'function') ? _normalizeTaskTypeForDb(task.task_type) : String(task.task_type || '');
    return _TASK_TYPE_HISTORY_LABELS[norm] || '社内試運転';
}

function _tagDescriptionWithMode(task, description) {
    return `[${_taskModeLabel(task)}] ${description}`;
}

const HISTORY_MODE_TAG_RE = /^\[(.+?)\]\s*/;
function _splitHistoryModeTag(description) {
    const m = HISTORY_MODE_TAG_RE.exec(description || '');
    return m ? { mode: m[1], rest: (description || '').slice(m[0].length) } : { mode: '', rest: description || '' };
}

// "<taskId>::<field>" -> { label, firstOldDisp, lastNewDisp, task, editor, timer }
const _historyPending = new Map();

function _escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function _histDisp(key, v, task) {
    if (key === 'end_date' && task && task.has_no_date) return '未定';
    if (key === 'start_date' || key === 'end_date') {
        if (v == null || v === '') return '';
        const d = (v instanceof Date) ? v : new Date(v);
        if (Number.isNaN(d.getTime())) return String(v);
        const target = (key === 'end_date') ? gantt.date.add(d, -1, 'day') : d;
        return _toDateStr(target);
    }
    if (key === 'is_business_trip') {
        return (v === true || String(v).toUpperCase() === 'TRUE') ? '出張予定' : '通常';
    }
    if (key === 'status') {
        const s = (v == null || v === '') ? '' : String(v).trim();
        return s === '' ? '' : s + '%';
    }
    return v == null ? '' : String(v).trim();
}

function _historyEditorName(task) {
    return (typeof window._getCurrentEditorName === 'function' ? window._getCurrentEditorName() : '') ||
        (task && task.last_updated_by) || '';
}

async function _insertHistoryRow(task, description, editor) {
    try {
        await supabaseClient.from('change_log').insert({
            source:         HISTORY_SOURCE,
            changed_by:     editor || '',
            project_number: String((task && task.project_number) || ''),
            machine:        String((task && task.machine) || ''),
            unit:           String((task && task.unit) || ''),
            task_text:      String((task && task.text) || ''),
            description:    description
        });
    } catch (e) {
        console.warn('変更履歴の記録エラー:', e);
    }
}

// Undo/Redo経由の変更は、変更内容の末尾に「（元に戻す）」「（やり直し）」を付けて通常編集と区別する
function _historySuffix(tag) {
    return tag ? `（${tag}）` : '';
}

async function _flushHistoryPending(key) {
    const p = _historyPending.get(key);
    if (!p) return;
    _historyPending.delete(key);
    if (p.firstOldDisp === p.lastNewDisp) return; // 最終的に変化なしなら記録しない
    const oldTxt = p.firstOldDisp === '' ? '(未設定)' : p.firstOldDisp;
    const newTxt = p.lastNewDisp === '' ? '(未設定)' : p.lastNewDisp;
    await _insertHistoryRow(p.task, _tagDescriptionWithMode(p.task, `${p.label}を変更：${oldTxt} → ${newTxt}`), p.editor);
}

function _queueHistoryChange(id, label, fieldKey, oldDisp, newDisp, task, editor) {
    if (oldDisp === newDisp) return;
    const key = String(id) + '::' + fieldKey;
    const existing = _historyPending.get(key);
    if (existing) {
        clearTimeout(existing.timer);
        existing.lastNewDisp = newDisp;
        existing.task = task;
        existing.editor = editor || existing.editor;
        existing.timer = setTimeout(function() { _flushHistoryPending(key); }, HISTORY_MERGE_WINDOW_MS);
    } else {
        _historyPending.set(key, {
            label: label,
            firstOldDisp: oldDisp,
            lastNewDisp: newDisp,
            task: task,
            editor: editor,
            timer: setTimeout(function() { _flushHistoryPending(key); }, HISTORY_MERGE_WINDOW_MS)
        });
    }
}

// 対象タスクの保留中（マージ待ち）の通常編集があれば、今すぐ確定させて記録する。
// Undo/Redo の記録より先に await で待つことで、DB上の記録順序（changed_at）が
// 実際の操作順（先に確定した通常編集 → 後のUndo/Redo）と入れ替わるのを防ぐ。
async function _flushPendingForTask(id) {
    for (const f of HISTORY_FIELDS) {
        const key = String(id) + '::' + f.key;
        const p = _historyPending.get(key);
        if (!p) continue;
        clearTimeout(p.timer);
        await _flushHistoryPending(key);
    }
}

async function _logTaskHistoryOnUpdate(id, before, after, tag) {
    if (!before || !after) return;
    const editor = _historyEditorName(after);
    if (tag) {
        // Undo/Redo は「ボタン一発」の単発操作。マージ待ちすると、直前の通常編集と
        // 差し引きゼロに見えて記録が消えてしまうことがあるため、待たずに即時記録する。
        await _flushPendingForTask(id);
        const changes = [];
        HISTORY_FIELDS.forEach(function(f) {
            const oldDisp = _histDisp(f.key, before[f.key], before);
            const newDisp = _histDisp(f.key, after[f.key], after);
            if (oldDisp === newDisp) return;
            const oldTxt = oldDisp === '' ? '(未設定)' : oldDisp;
            const newTxt = newDisp === '' ? '(未設定)' : newDisp;
            changes.push(`${f.label}を変更：${oldTxt} → ${newTxt}`);
        });
        if (changes.length === 0) return;
        await _insertHistoryRow(after, _tagDescriptionWithMode(after, changes.join('／') + _historySuffix(tag)), editor);
        return;
    }
    HISTORY_FIELDS.forEach(function(f) {
        const oldDisp = _histDisp(f.key, before[f.key], before);
        const newDisp = _histDisp(f.key, after[f.key], after);
        if (oldDisp === newDisp) return;
        _queueHistoryChange(id, f.label, f.key, oldDisp, newDisp, after, editor);
    });
}

async function _logTaskHistoryOnAdd(task, tag) {
    if (!task) return;
    if (tag) await _flushPendingForTask(task.id);
    await _insertHistoryRow(task, _tagDescriptionWithMode(task, 'タスクを追加しました' + _historySuffix(tag)), _historyEditorName(task));
}

async function _logTaskHistoryOnDelete(task, tag) {
    if (!task) return;
    if (tag) await _flushPendingForTask(task.id);
    await _insertHistoryRow(task, _tagDescriptionWithMode(task, 'タスクを削除しました' + _historySuffix(tag)), _historyEditorName(task));
}

// _pushUndoEntry（gantt-setup.js）から呼び出される共通フック。
// tag を渡すと Undo/Redo による変更であることを履歴に付記する（通常編集時は未指定）。
// batch内の複数項目は for...of + await で直列実行し、記録順序を操作順と一致させる。
async function _recordTaskHistory(entry, tag) {
    try {
        const items = (entry && entry.type === 'batch') ? entry.items : [entry];
        for (const sub of items) {
            if (!sub) continue;
            if (sub.type === 'update') await _logTaskHistoryOnUpdate(sub.id, sub.before, sub.after, tag);
            else if (sub.type === 'delete') await _logTaskHistoryOnDelete(sub.before, tag);
            else if (sub.type === 'add') await _logTaskHistoryOnAdd(sub.after, tag);
        }
    } catch (e) {
        console.warn('変更履歴の記録エラー:', e);
    }
}

// Undo は DB を「before」状態へ戻す操作なので、変化の向きを反転させてから履歴に渡す
// （update: before/afterを入替、delete: 復元＝追加として記録、add: 取消＝削除として記録）
function _invertEntryForHistory(entry) {
    function invertSub(sub) {
        if (!sub) return sub;
        if (sub.type === 'update') return { type: 'update', id: sub.id, before: sub.after, after: sub.before };
        if (sub.type === 'delete') return { type: 'add', id: sub.id, after: sub.before };
        if (sub.type === 'add') return { type: 'delete', id: sub.id, before: sub.after };
        return sub;
    }
    if (entry && entry.type === 'batch') return { type: 'batch', items: entry.items.map(invertSub) };
    return invertSub(entry);
}

// タブを離れる・閉じる直前に保留中の履歴をできる限り書き込む
function _flushAllHistoryPending() {
    _historyPending.forEach(function(p, key) {
        clearTimeout(p.timer);
        _flushHistoryPending(key);
    });
}
document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') _flushAllHistoryPending();
});
window.addEventListener('beforeunload', _flushAllHistoryPending);

// ===== 変更履歴モーダル =====
let _historyLogData = [];
let _historyLogFilter = { keyword: '', dateFrom: '', dateTo: '', preset: '' };

function _historyDateKey(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function openHistoryModal() {
    const overlay = document.getElementById('history_overlay');
    const wrap = document.getElementById('history_log_wrap');
    wrap.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">読み込み中...</div>';
    overlay.classList.add('open');

    const oneMonthAgo = new Date();
    oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

    const { data, error } = await supabaseClient
        .from('change_log')
        .select('*')
        .eq('source', HISTORY_SOURCE)
        .gte('changed_at', oneMonthAgo.toISOString())
        .order('changed_at', { ascending: false })
        .limit(500);

    if (error) {
        wrap.innerHTML = '<div style="padding:20px;text-align:center;color:#f44;">変更履歴の取得に失敗しました：' + _escHtml(error.message) + '</div>';
        return;
    }

    _historyLogData = data || [];
    if (_historyLogData.length === 0) {
        wrap.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">過去1ヶ月の変更履歴はありません</div>';
        return;
    }

    const dates = _historyLogData.map(function(r) { return _historyDateKey(r.changed_at); }).filter(Boolean).sort();
    _historyLogFilter = { keyword: '', dateFrom: dates[0] || '', dateTo: dates[dates.length - 1] || '', preset: '' };
    _renderHistoryLog();
}
window.openHistoryModal = openHistoryModal;

function closeHistoryModal() {
    document.getElementById('history_overlay').classList.remove('open');
}
window.closeHistoryModal = closeHistoryModal;

function _setHistoryFilterKeyword(v) {
    _historyLogFilter.keyword = (v || '').trim();
    _renderHistoryTable();
}
window.setHistoryFilterKeyword = _setHistoryFilterKeyword;

function _setHistoryFilterDateFrom(v) {
    _historyLogFilter.dateFrom = v || '';
    _historyLogFilter.preset = '';
    _renderHistoryTable();
}
window.setHistoryFilterDateFrom = _setHistoryFilterDateFrom;

function _setHistoryFilterDateTo(v) {
    _historyLogFilter.dateTo = v || '';
    _historyLogFilter.preset = '';
    _renderHistoryTable();
}
window.setHistoryFilterDateTo = _setHistoryFilterDateTo;

function _setHistoryFilterPreset(preset) {
    const now = new Date();
    const mk = function(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const day = now.getDay();
    if (preset === 'thisWeek') {
        const monday = new Date(now);
        monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
        _historyLogFilter.dateFrom = mk(monday);
        _historyLogFilter.dateTo = mk(now);
        _historyLogFilter.preset = 'thisWeek';
    } else if (preset === 'lastWeek') {
        const thisMonday = new Date(now);
        thisMonday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
        const lastMonday = new Date(thisMonday);
        lastMonday.setDate(thisMonday.getDate() - 7);
        const lastSunday = new Date(thisMonday);
        lastSunday.setDate(thisMonday.getDate() - 1);
        _historyLogFilter.dateFrom = mk(lastMonday);
        _historyLogFilter.dateTo = mk(lastSunday);
        _historyLogFilter.preset = 'lastWeek';
    }
    _renderHistoryTable();
}
window.setHistoryFilterPreset = _setHistoryFilterPreset;

function _clearHistoryFilter() {
    const dates = _historyLogData.map(function(r) { return _historyDateKey(r.changed_at); }).filter(Boolean).sort();
    _historyLogFilter = { keyword: '', dateFrom: dates[0] || '', dateTo: dates[dates.length - 1] || '', preset: '' };
    _renderHistoryLog();
}
window.clearHistoryFilter = _clearHistoryFilter;

function _getFilteredHistoryRows() {
    const kw = (_historyLogFilter.keyword || '').toLowerCase();
    return _historyLogData.filter(function(row) {
        const dk = _historyDateKey(row.changed_at);
        if (_historyLogFilter.dateFrom && dk && dk < _historyLogFilter.dateFrom) return false;
        if (_historyLogFilter.dateTo && dk && dk > _historyLogFilter.dateTo) return false;
        if (!kw) return true;
        const target = [row.project_number, row.machine, row.unit, row.task_text, row.description, row.changed_by]
            .join(' ').toLowerCase();
        return target.indexOf(kw) >= 0;
    });
}

function _renderHistoryLog() {
    const wrap = document.getElementById('history_log_wrap');
    wrap.innerHTML = `
        <div style="position:sticky;top:0;z-index:5;background:#fff;padding:8px 4px 14px;">
            <div style="display:flex;gap:10px;align-items:center;margin-bottom:10px;">
                <label style="font-size:13px;color:#555;white-space:nowrap;">キーワード</label>
                <input type="text" value="${_escHtml(_historyLogFilter.keyword || '')}" placeholder="工事番号・機械・タスク名・変更内容・変更者..." oninput="setHistoryFilterKeyword(this.value)" style="flex:1;min-width:220px;padding:7px 10px;border:1px solid #ccc;border-radius:4px;font-size:13px;">
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <label style="font-size:13px;color:#555;">期間</label>
                <input type="date" value="${_escHtml(_historyLogFilter.dateFrom || '')}" onchange="setHistoryFilterDateFrom(this.value)" style="padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;">
                <span style="font-size:13px;color:#666;">〜</span>
                <input type="date" value="${_escHtml(_historyLogFilter.dateTo || '')}" onchange="setHistoryFilterDateTo(this.value)" style="padding:6px 8px;border:1px solid #ccc;border-radius:4px;font-size:13px;">
                <button class="btn" style="font-size:12px;padding:4px 10px;${_historyLogFilter.preset === 'thisWeek' ? 'background:#1565c0;color:#fff;' : ''}" onclick="setHistoryFilterPreset('thisWeek')">今週</button>
                <button class="btn" style="font-size:12px;padding:4px 10px;${_historyLogFilter.preset === 'lastWeek' ? 'background:#1565c0;color:#fff;' : ''}" onclick="setHistoryFilterPreset('lastWeek')">先週</button>
                <button class="btn" style="font-size:12px;padding:4px 10px;" onclick="clearHistoryFilter()">クリア</button>
                <span id="history_log_count" style="margin-left:auto;font-size:13px;color:#666;white-space:nowrap;"></span>
            </div>
        </div>
        <div id="history_log_table"></div>`;
    _renderHistoryTable();
}

function _renderHistoryTable() {
    const tableDiv = document.getElementById('history_log_table');
    if (!tableDiv) return;
    const rows = _getFilteredHistoryRows();
    const countEl = document.getElementById('history_log_count');
    if (countEl) countEl.textContent = `表示 ${rows.length} / ${_historyLogData.length} 件`;

    if (rows.length === 0) {
        tableDiv.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">条件に一致する変更履歴はありません</div>';
        return;
    }

    const fmtDt = function(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        return `${String(d.getFullYear()).slice(-2)}/${d.getMonth() + 1}/${d.getDate()} ` +
            String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    };

    const th = 'font-size:13px;';
    const td = 'font-size:13px;';
    let html = `<table>
        <thead><tr>
            <th style="${th}">更新日時</th><th style="${th}">タブ</th><th style="${th}">工事番号</th><th style="${th}">機械</th><th style="${th}">ユニット</th><th style="${th}">タスク名</th><th style="${th}">変更内容</th><th style="${th}">変更者</th>
        </tr></thead>
        <tbody>`;
    rows.forEach(function(r) {
        const { mode, rest } = _splitHistoryModeTag(r.description);
        html += `<tr>
            <td style="${td}">${_escHtml(fmtDt(r.changed_at))}</td>
            <td style="${td}">${_escHtml(mode)}</td>
            <td style="${td}">${_escHtml(r.project_number)}</td>
            <td style="${td}">${_escHtml(r.machine)}</td>
            <td style="${td}">${_escHtml(r.unit)}</td>
            <td style="white-space:normal;${td}">${_escHtml(r.task_text)}</td>
            <td style="white-space:normal;${td}">${_escHtml(rest)}</td>
            <td style="${td}">${_escHtml(r.changed_by)}</td>
        </tr>`;
    });
    html += '</tbody></table>';
    tableDiv.innerHTML = html;
}
