# Planogram Builder

Standalone, dependency-free planogram tool. Open `index.html` in a browser, load a CSV (or the sample data) and press **Generate layout**.

- `engine.js`: the auto-layout engine (browser and Node). `Planogram.generate(products, options)`.
- `engine.test.js`: run with `node --test engine.test.js`.

## Plan from a photo

`node server.js` (set `ANTHROPIC_API_KEY`, or run `ant auth login` first), then open http://localhost:3100. Choose or take a photo of a shelf, optionally enter the shelf run width in mm so pack sizes are scaled, and press **Read photo**. Claude (`claude-opus-5-5`) lists each product with its category, facings, units stacked deep and estimated pack size. Check and correct the table (names, facings, units deep), then **Generate layout**. The counts you confirm are kept exactly (units = facings x units deep) and the layout is blocked by category with the fastest stock on the best shelves; current stock is used as the demand signal. The layout CSV includes a units column.

The photo is sent to the Anthropic API; nothing is stored. Pack sizes and depth counts are estimates, so review low-confidence rows. Tests use a fake Claude client; the live API call has not been exercised in this repo yet.

## How the layout is made

1. **Facings** per product = days of cover x sales per day / units that fit in the shelf depth, clamped to the product's min/max facings.
2. **Shrink to fit**: if the range is too wide, facings are cut where cover per mm saved is highest; if still too wide the slowest sellers are dropped and listed with a reason.
3. **Category blocks**: categories become left-to-right column blocks, biggest sellers first.
4. **Shelf placement**: inside a block the fastest sellers go on the best shelves (peak at eye level, a little above the middle); items must fit the shelf height.
5. If column blocking leaves items without room, the width budget is tightened and the layout retried.

CSV columns: `sku, name, category, width, height, depth` (mm), `velocity` (units per day), optional `min facings`, `max facings`. Common alternative headers (e.g. `Stock Code`, `Description`, `Sales per day`) are recognised.

Not yet modelled: bay dividers (items may straddle them), product rotation, hanging pegs, shelf-by-shelf adjustable heights in the UI, manual drag-and-drop edits.
