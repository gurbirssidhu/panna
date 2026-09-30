# Rebuilding the bundled engines (www/vendor)

The built files are committed so the app builds without these steps. Rebuild only to upgrade.

- **pdf.js 3.11.174**: copy `pdf.min.js`, `pdf.worker.min.js`, `cmaps/`, `standard_fonts/` from `node_modules/pdfjs-dist` (`build/` and the package root).
- **JSZip 3.10.1**: `node_modules/jszip/dist/jszip.min.js`.
- **DjVu.js 0.5.4**: `npm pack djvujs-dist@0.5.4`, then in `package/library`: `npm install`, remove the two extra outputs from `rollup.config.js`, `npx rollup --config`, copy `dist/djvu.js`.
- **Dictionary**: `python3 tools/build_dict.py`.
- **Icons**: `python3 tools/make_icon.py android/app/src/main/res` (needs Pillow).
