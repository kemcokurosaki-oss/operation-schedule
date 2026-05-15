// ---- 完了工事一覧（閲覧のみ）----
// ・全体工程表の completed_projects ＋ tasks.is_archived=true の工事番号のうち、
//   操業工程表の対象タスクが1件以上ある工事だけを一覧表示
// ・詳細モーダルは組立工程表と同様「操業」「出張」の2タブ（設計工程表の図面/計画など4タブは廃止）

async function openArchiveList() {
    const tableDiv = document.getElementById('archive_list_table');
    tableDiv.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">読み込み中...</div>';

    if (typeof _refreshCompletedProjectNumbers === 'function') {
        await _refreshCompletedProjectNumbers();
    }

    const [cpRes, archRes] = await Promise.all([
        supabaseClient.from('completed_projects').select('*').order('project_number', { ascending: true }),
        supabaseClient
            .from('tasks')
            .select('project_number, customer_name, project_details, archived_at, is_detailed')
            .eq('is_archived', true)
    ]);

    if (cpRes.error) { alert('読み込みエラー: ' + cpRes.error.message); return; }
    if (archRes.error) { alert('読み込みエラー: ' + archRes.error.message); return; }

    const map = new Map();
    (cpRes.data || []).forEach(cp => {
        const num = String(cp.project_number || '').trim();
        if (!num) return;
        const completedDate = cp.completed_date != null && cp.completed_date !== ''
            ? String(cp.completed_date).trim()
            : '';
        map.set(num, {
            customer: cp.customer_name || '',
            details: cp.project_details || '',
            completedDate
        });
    });
    (archRes.data || []).forEach(t => {
        const num = String(t.project_number || '').trim();
        if (!num || map.has(num)) return;
        map.set(num, {
            customer: t.customer_name || '',
            details: t.project_details || '',
            completedDate: t.archived_at ? String(t.archived_at).trim() : ''
        });
    });

    let rows = Array.from(map.entries()).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (typeof _filterProjectNumbersWithOperationTasks === 'function') {
        const allowed = await _filterProjectNumbersWithOperationTasks(rows.map(([n]) => n));
        rows = rows.filter(([num]) => allowed.has(String(num).trim()));
    }

    if (rows.length === 0) {
        tableDiv.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">完了済みの工事はありません</div>';
    } else {
        tableDiv.innerHTML = `<table>
            <thead><tr><th>工事番号</th><th>顧客名</th><th>工事概要</th><th>完了日</th><th>操作</th></tr></thead>
            <tbody>${rows.map(([num, info]) => `
                <tr>
                    <td>${num}</td>
                    <td>${info.customer}</td>
                    <td>${info.details}</td>
                    <td>${info.completedDate}</td>
                    <td style="white-space:nowrap;">
                        <button class="btn" style="font-size:11px;padding:2px 8px;" onclick="openArchiveDetail('${num}')">詳細</button>
                    </td>
                </tr>`).join('')}
            </tbody></table>`;
    }
    document.getElementById('archive_list_overlay').classList.add('open');
}

function closeArchiveList() {
    document.getElementById('archive_list_overlay').classList.remove('open');
}

let _archiveDetailProjectNumber = null;
let _archiveDetailTaskType = 'operation';

async function openArchiveDetail(projectNumber) {
    _archiveDetailProjectNumber = projectNumber;
    _archiveDetailTaskType = 'operation';
    document.getElementById('archive_detail_title').textContent = `${projectNumber} のタスク一覧`;
    document.getElementById('archive_detail_overlay').classList.add('open');
    await _loadArchiveDetailTable();
}

function switchArchiveDetailTab(taskType) {
    _archiveDetailTaskType = taskType;
    _loadArchiveDetailTable();
}

function _archiveDetailRowVisible(t, inMasterCompleted) {
    const detailed = t.is_detailed === true || String(t.is_detailed).toUpperCase() === 'TRUE';
    if (detailed) return false;

    let modeOk = false;
    if (_archiveDetailTaskType === 'business_trip') {
        modeOk = typeof _isTripTask === 'function' && _isTripTask(t)
            && typeof _isOperationMajorItem === 'function' && _isOperationMajorItem(t.major_item);
    } else {
        modeOk = typeof _isOperationArchiveMainTabTask === 'function' && _isOperationArchiveMainTabTask(t);
    }
    if (!modeOk) return false;

    if (inMasterCompleted) return true;
    return t.is_archived === true || String(t.is_archived).toUpperCase() === 'TRUE';
}

function _sortArchiveDetailRows(rows) {
    return rows.slice().sort((a, b) => {
        const ma = String(a.machine ?? '');
        const mb = String(b.machine ?? '');
        if (ma !== mb) return ma.localeCompare(mb, 'ja', { numeric: true, sensitivity: 'base' });
        const ua = String(a.unit ?? '');
        const ub = String(b.unit ?? '');
        if (ua !== ub) return ua.localeCompare(ub, 'ja', { numeric: true, sensitivity: 'base' });
        const sa = a.start_date ? String(a.start_date).substring(0, 10) : '';
        const sb = b.start_date ? String(b.start_date).substring(0, 10) : '';
        if (sa !== sb) return sa.localeCompare(sb);
        const oa = Number(a.sort_order != null ? a.sort_order : 1e9);
        const ob = Number(b.sort_order != null ? b.sort_order : 1e9);
        if (oa !== ob) return oa - ob;
        return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    });
}

async function _loadArchiveDetailTable() {
    const typeFilter = _archiveDetailTaskType;
    ['operation', 'business_trip'].forEach(t => {
        const btn = document.getElementById('dtab_' + t);
        if (btn) btn.classList.toggle('active', t === typeFilter);
    });

    const tableDiv = document.getElementById('archive_detail_table');
    tableDiv.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">読み込み中...</div>';

    if (typeof _refreshCompletedProjectNumbers === 'function') {
        await _refreshCompletedProjectNumbers();
    }
    const inMasterCompleted =
        typeof _isProjectCompletedOnMasterSchedule === 'function' &&
        _isProjectCompletedOnMasterSchedule(_archiveDetailProjectNumber);

    const { data, error } = await supabaseClient
        .from('tasks')
        .select('*')
        .eq('project_number', _archiveDetailProjectNumber)
        .neq('is_detailed', true)
        .order('machine', { ascending: true, nullsFirst: true })
        .order('unit', { ascending: true, nullsFirst: true })
        .order('start_date', { ascending: true, nullsFirst: true })
        .order('sort_order', { ascending: true, nullsFirst: false });
    if (error) { alert('読み込みエラー: ' + error.message); return; }

    const filtered = _sortArchiveDetailRows((data || []).filter(t => _archiveDetailRowVisible(t, inMasterCompleted)));

    if (filtered.length === 0) {
        tableDiv.innerHTML = '<div style="padding:20px;text-align:center;color:#888;">このモードのタスクはありません</div>';
    } else {
        tableDiv.innerHTML = `<table>
            <colgroup>
                <col style="width:90px;">
                <col style="width:44px;">
                <col style="width:44px;">
                <col style="width:110px;">
                <col style="width:80px;">
                <col style="width:80px;">
                <col style="width:38px;">
            </colgroup>
            <thead><tr>
                <th>タスク名</th><th>機械</th><th>ユニ</th>
                <th>担当</th><th>開始日</th><th>完了予定日</th><th>日数</th>
            </tr></thead>
            <tbody>${filtered.map(t => `
                <tr>
                    <td>${t.text || ''}</td>
                    <td>${t.machine || ''}</td>
                    <td>${t.unit || ''}</td>
                    <td>${t.owner || ''}</td>
                    <td>${t.start_date ? t.start_date.substring(0, 10) : ''}</td>
                    <td>${t.end_date ? t.end_date.substring(0, 10) : ''}</td>
                    <td>${t.duration != null ? t.duration : ''}</td>
                </tr>`).join('')}
            </tbody></table>`;
    }
}

function closeArchiveDetail() {
    document.getElementById('archive_detail_overlay').classList.remove('open');
}

// 実行
initialize();
