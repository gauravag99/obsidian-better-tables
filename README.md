# Better Tables (Please)

If you are frustrated with making tables in your notes, install this. Summon the interactive table via the ```Table``` block. Just drag to resize and reorder, hover to insert, click to edit.
<img alt="bettertables" src="https://github.com/user-attachments/assets/fccec811-d59e-4aca-bf2b-3ec37177494b" />

## Features

- **Click a cell to select it. Click again to edit.** (Or turn on "Quick text edit" to edit with one click.)
- **Move around with the keyboard.** Use the arrow keys, or `Tab` and `Enter`.
- **Press `Enter` on a selected cell** to start editing it.
- **Drag across cells** to select a block. Then copy it, or press `Delete` to clear it.
- **Merge cells.** Select a block of cells and right-click → **Merge cells** (or press `Alt+M`). Right-click a merged cell → **Unmerge cells** (or `Alt+Shift+M`).
- **Paste a picture into a cell.** It's saved to your attachment folder and embedded; it no longer disappears when you leave the cell.
- **Drag the lines** between rows and columns to resize them.
- **Drag the handles** on the top and left edges to reorder rows and columns.
- **Hover between cells** and click the dot to insert a row or column.
- **Click the `+` buttons** on the right and bottom to add a row or column.
- **Right-click a cell** to align its column left, center, or right.
- **Add a line break inside a cell** with `Shift+Enter`.
- **Delete the whole table** with the trash button in the top corner.
- Wide tables scroll sideways. Your column widths and row heights are saved.

## Usage

1. Add a code block with the word `table`, like this:

````
```table
```
````

Go to the next line, you'd summoned you interactive table.

2. run the **Better Tables: Insert table** command from the command palette.

3. If you have ````slash commander```` core plugin installed, you can use ````/better tables````

Your table is saved as a normal Markdown table, so it still works everywhere else. Column widths and row heights are kept in a small hidden comment inside the block (e.g. `<!-- tk:cols=140,140;rows=48,48 -->`).

### Merged cells

Markdown has no `colspan`/`rowspan`, so merged cells are stored in that same hidden comment and painted by the plugin:

````
```table
| Quarterly totals |     | Q1 | Q2 |
| --- | --- | --- | --- |
| North | Ann | 60 | 70 |
| South | Bob | 60 | 60 |
<!-- tk:cols=140,140;rows=48,48,48;merge=0,0,1,2 -->
```
````

- Each `merge=` entry is `row,column,rowSpan,colSpan` (0-based), separated by `|`.
- The top-left cell holds the text; every cell it covers is written as an empty cell, so the block stays a valid, readable Markdown table elsewhere. No information is hidden: merging joins the text of the selected cells into the top-left cell, one line per cell.
- If you type text into a cell that a merge covers (in source mode), that merge is ignored rather than hiding the text; merge again to restore it.
- Merging, unmerging, inserting/deleting rows and columns, and reordering with the handles all keep the regions valid. A reorder that would tear a merged region apart simply unmerges it.
- Merged regions can't overlap: merging over an existing merge replaces it.

### Images

A cell holds Markdown text, so a picture pasted straight from the clipboard is written to your **attachment folder** (Obsidian's own attachment settings are respected) and inserted as an embed, e.g. `![[Pasted image 20261125201345.png]]`. That works for screenshots, images copied from another app, and files copied in the file manager.

- Images copied from a web page are inserted as `![](https://…)`.
- Inline `data:` and `blob:` images are saved as real files, so a huge data URL never ends up in your note.
- Embeds are limited to the column width, so the table layout stays intact.
- Plain text, `[[links]]` and existing `![[embeds]]` paste exactly as before.
- Dropping an image file onto a cell appends it the same way.

Embeds are written the way Obsidian itself writes them — following your **link format** settings (wikilinks or Markdown links, relative or vault-absolute path) — but with the display text removed: `![[Attachments/photo.webp]]`, or `![](./Attachments/photo.webp)`. Themes and plugins that render alt text as a caption therefore have nothing to show, instead of labelling every picture with its file name.

Images inside a cell behave like they do elsewhere in Obsidian: links, embeds and controls added by other plugins (image toolbars, converters, zoom buttons…) receive their own clicks, and right-clicking an image opens its native menu — with whatever other plugins add to it — instead of the table's menu. To select a cell that is completely covered by an image, click its border or reach it with the keyboard.

## Settings
If you like to immediately select & edit text (bypassing having to select the cell first), you can turn on ````Quick text edit```` in the setting.

## Installation
Add to Obsidian https://community.obsidian.md/plugins/better-tables

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Copy them into `<your-vault>/.obsidian/plugins/better-tables/`.
3. Reload Obsidian and enable **Better Tables** under Settings → Community plugins.

## Support

Thank you for using Better Tables! If you run into a bug or have an idea, please [open an issue](https://github.com/yaye-work/obsidian-better-tables/issues). Feature requests and bug reports are very welcome.
And if you find inline notes useful, you can:

[<img width=auto height="70" alt="buymea bubbletea" src="https://github.com/user-attachments/assets/0f9d8765-d124-4e63-8668-bf06100b7c0a" />](https://buymeacoffee.com/yaye.work)

It's genuinely appreciated.

Happy noting! 
Yaye

## License

[MIT](LICENSE)


