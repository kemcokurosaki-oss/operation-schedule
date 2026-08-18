# -*- coding: utf-8 -*-
import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
from openpyxl.utils import get_column_letter

rows = [
    (1, "新機能", "完了工事一覧に「計画」タブを追加し、通常画面と同じ3タブ構成に変更"),
    (2, "新機能", "表の列見出しにフィルター・並べ替え機能を追加（従来の絞り込みボタンは廃止）"),
    (3, "新機能", "担当別画面でバーをドラッグして移動・伸縮できるように改善"),
    (4, "新機能", "表の列幅をドラッグで自由に調整できるように改善"),
    (5, "UI改善", "ガントバー・担当別バーの表示に工事番号・機械名を追加"),
    (6, "UI改善", "担当者プルダウンに「未定」を追加"),
    (7, "UI改善", "担当別画面の並び順を開始日順に変更し、機械名も表示"),
    (8, "UI改善", "タスク編集画面（ライトボックス）を拡大して見やすく改善"),
    (9, "UI改善", "画面上部のボタン配置を整理"),
    (10, "不具合修正", "開始日・終了日を個別編集すると他方まで変わってしまう不具合を修正"),
    (11, "不具合修正", "担当別フルスクリーン表示の崩れを修正"),
    (12, "不具合修正", "担当別フルスクリーンでダブルクリック編集ができない不具合を修正"),
    (13, "不具合修正", "工事番号未選択でも新規タスクを追加できるよう修正"),
    (14, "仕様変更", "「現地試運転」モードを廃止し「出張」モードに統合"),
    (15, "仕様変更", "表示モードボタンの再クリックで担当別画面に戻らない仕様に変更"),
    (16, "その他", "「試運転」の表記を「社内試運転」に統一"),
]

CATEGORY_COLORS = {
    "新機能": "DDEBF7",
    "不具合修正": "FCE4E4",
    "UI改善": "E2EFDA",
    "仕様変更": "FFF2CC",
    "その他": "F2F2F2",
}

wb = openpyxl.Workbook()
ws = wb.active
ws.title = "修正内容報告"

thin = Side(style="thin", color="BFBFBF")
border = Border(left=thin, right=thin, top=thin, bottom=thin)

# タイトル
ws.merge_cells("A1:C1")
ws["A1"] = "操業工程表アプリ 修正内容報告（対象期間：2026年8月17日～8月18日）"
ws["A1"].font = Font(size=14, bold=True)
ws["A1"].alignment = Alignment(horizontal="left", vertical="center")
ws.row_dimensions[1].height = 26

ws["A2"] = "作成日：2026年8月18日"
ws["A2"].font = Font(size=10, italic=True, color="666666")

# ヘッダー行
headers = ["No.", "カテゴリ", "変更内容"]
header_row = 4
for col, h in enumerate(headers, start=1):
    c = ws.cell(row=header_row, column=col, value=h)
    c.font = Font(bold=True, color="FFFFFF")
    c.fill = PatternFill("solid", fgColor="4472C4")
    c.alignment = Alignment(horizontal="center", vertical="center")
    c.border = border

# データ行
r = header_row + 1
for no, cat, content in rows:
    ws.cell(row=r, column=1, value=no).alignment = Alignment(horizontal="center", vertical="center")
    cat_cell = ws.cell(row=r, column=2, value=cat)
    cat_cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    fill_color = CATEGORY_COLORS.get(cat, "FFFFFF")
    cat_cell.fill = PatternFill("solid", fgColor=fill_color)
    content_cell = ws.cell(row=r, column=3, value="・" + content)
    content_cell.alignment = Alignment(horizontal="left", vertical="center", wrap_text=True)
    for col in range(1, 4):
        ws.cell(row=r, column=col).border = border
    ws.row_dimensions[r].height = 24
    r += 1

# 列幅
widths = {"A": 6, "B": 14, "C": 100}
for col, w in widths.items():
    ws.column_dimensions[col].width = w

ws.freeze_panes = f"A{header_row+1}"

# 集計シート
summary = {}
for _, cat, _ in rows:
    key = cat
    summary[key] = summary.get(key, 0) + 1

ws2 = wb.create_sheet("集計")
ws2["A1"] = "カテゴリ別 件数"
ws2["A1"].font = Font(size=12, bold=True)
ws2["A3"] = "カテゴリ"
ws2["B3"] = "件数"
ws2["A3"].font = Font(bold=True)
ws2["B3"].font = Font(bold=True)
for i, (k, v) in enumerate(summary.items(), start=4):
    ws2.cell(row=i, column=1, value=k)
    ws2.cell(row=i, column=2, value=v)
ws2.column_dimensions["A"].width = 20
ws2.column_dimensions["B"].width = 10

out_path = r"c:\Users\kurosaki\OneDrive - 日下部電機\デスクトップ\工程表作成\操業工程表\修正内容報告_20260817-18.xlsx"
wb.save(out_path)
print("saved:", out_path)
