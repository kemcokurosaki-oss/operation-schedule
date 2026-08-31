// ===== 変更履歴（change_log への記録・閲覧） =====
// 全体工程表・組立工程表・設計工程表と共有の change_log テーブルに、
// source = '操業工程表' として書き込む。change_log は SELECT/INSERT のみ許可されており
// UPDATE/DELETE の権限が無いため、同一タスク・同一項目への連続した変更は
// 一定時間（HISTORY_MERGE_WINDOW_MS）書き込みを保留してまとめてから1件だけ INSERT する。
const HISTORY_SOURCE = '操業工程表';
const HISTORY_MERGE_WINDOW_MS = 5000;

const HISTORY_FIELDS = [
    { key: 'task_type',        label: 'モード' },
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

// "<taskId>::<field>" -> { label, firstOldDisp, lastNewDisp, task, editor, timer }
const _historyPending = new Map();

function _escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function _histDisp(key, v, task) {
    if (key === 'task_type') {
        const norm = (typeof _normalizeTaskTypeForDb === 'function') ? _normalizeTaskTypeForDb(v) : String(v || '');
        return _TASK_TYPE_HISTORY_LABELS[norm] || (v == null ? '' : String(v).trim());
    }
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

function _flushHistoryPending(key) {
    const p = _historyPending.get(key);
    if (!p) return;
    _historyPending.delete(key);
    if (p.firstOldDisp === p.lastNewDisp) return; // 最終的に変化なしなら記録しない
    const oldTxt = p.firstOldDisp === '' ? '(未設定)' : p.firstOldDisp;
    const newTxt = p.lastNewDisp === '' ? '(未設定)' : p.lastNewDisp;
    _insertHistoryRow(p.task, `${p.label}を変更：${oldTxt} → ${newTxt}`, p.editor);
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

function _logTaskHistoryOnUpdate(id, before, after) {
    if (!before || !after) return;
    const editor = _historyEditorName(after);
    HISTORY_FIELDS.forEach(function(f) {
        const oldDisp = _histDisp(f.key, before[f.key], before);
        const newDisp = _histDisp(f.key, after[f.key], after);
        if (oldDisp === newDisp) return;
        _queueHistoryChange(id, f.label, f.key, oldDisp, newDisp, after, editor);
    });
}

function _logTaskHistoryOnAdd(task) {
    if (!task) return;
    _insertHistoryRow(task, 'タスクを追加しました', _historyEditorName(task));
}

function _logTaskHistoryOnDelete(task) {
    if (!task) return;
    _insertHistoryRow(task, 'タスクを削除しました', _historyEditorName(task));
}

// _pushUndoEntry（gantt-setup.js）から呼び出される共通フック
function _recordTaskHistory(entry) {
    try {
        const items = (entry && entry.type === 'batch') ? entry.items : [entry];
        items.forEach(function(sub) {
            if (!sub) return;
            if (sub.type === 'update') _logTaskHistoryOnUpdate(sub.id, sub.before, sub.after);
            else if (sub.type === 'delete') _logTaskHistoryOnDelete(sub.before);
            else if (sub.type === 'add') _logTaskHistoryOnAdd(sub.after);
        });
    } catch (e) {
        console.warn('変更履歴の記録エラー:', e);
    }
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
        <div style="position:sticky;top:0;z-index:5;background:#fff;padding:0 0 8px;">
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px;">
                <label style="font-size:12px;color:#555;white-space:nowrap;">キーワード</label>
                <input type="text" value="${_escHtml(_historyLogFilter.keyword || '')}" placeholder="工事番号・機械・タスク名・変更内容・変更者..." oninput="setHistoryFilterKeyword(this.value)" style="flex:1;min-width:220px;padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-size:12px;">
            </div>
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <label style="font-size:12px;color:#555;">期間</label>
                <input type="date" value="${_escHtml(_historyLogFilter.dateFrom || '')}" onchange="setHistoryFilterDateFrom(this.value)" style="padding:3px 6px;border:1px solid #ccc;border-radius:4px;font-size:12px;">
                <span style="font-size:12px;color:#666;">〜</span>
                <input type="date" value="${_escHtml(_historyLogFilter.dateTo || '')}" onchange="setHistoryFilterDateTo(this.value)" style="padding:3px 6px;border:1px solid #ccc;border-radius:4px;font-size:12px;">
                <button class="btn" style="font-size:11px;padding:2px 8px;${_historyLogFilter.preset === 'thisWeek' ? 'background:#1565c0;color:#fff;' : ''}" onclick="setHistoryFilterPreset('thisWeek')">今週</button>
                <button class="btn" style="font-size:11px;padding:2px 8px;${_historyLogFilter.preset === 'lastWeek' ? 'background:#1565c0;color:#fff;' : ''}" onclick="setHistoryFilterPreset('lastWeek')">先週</button>
                <button class="btn" style="font-size:11px;padding:2px 8px;" onclick="clearHistoryFilter()">クリア</button>
                <span id="history_log_count" style="margin-left:auto;font-size:12px;color:#666;white-space:nowrap;"></span>
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

    let html = `<table>
        <thead><tr>
            <th>更新日時</th><th>工事番号</th><th>機械</th><th>ユニット</th><th>タスク名</th><th>変更内容</th><th>変更者</th>
        </tr></thead>
        <tbody>`;
    rows.forEach(function(r) {
        html += `<tr>
            <td>${_escHtml(fmtDt(r.changed_at))}</td>
            <td>${_escHtml(r.project_number)}</td>
            <td>${_escHtml(r.machine)}</td>
            <td>${_escHtml(r.unit)}</td>
            <td style="white-space:normal;">${_escHtml(r.task_text)}</td>
            <td style="white-space:normal;">${_escHtml(r.description)}</td>
            <td>${_escHtml(r.changed_by)}</td>
        </tr>`;
    });
    html += '</tbody></table>';
    tableDiv.innerHTML = html;
}
