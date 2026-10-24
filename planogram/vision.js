/* Reads a shelf photo with Claude and returns the products, facings and counts it can see. */
const MODEL = 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['shelf_count', 'products', 'notes'],
  properties: {
    shelf_count: { type: 'integer', description: 'Number of shelves visible, top to bottom' },
    notes: { type: 'string', description: 'Anything the user should check: blurry areas, hidden items, guesses' },
    products: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'category', 'shelf', 'position', 'facings', 'units_deep', 'width_mm', 'height_mm', 'depth_mm', 'confidence'],
        properties: {
          name: { type: 'string', description: 'Brand and product name as printed on the pack, with size if readable' },
          category: { type: 'string', description: 'Short product category, e.g. "Pain relief"' },
          shelf: { type: 'integer', description: 'Shelf number, 1 = top' },
          position: { type: 'integer', description: 'Order left to right on that shelf, 1 = leftmost' },
          facings: { type: 'integer', description: 'Number of packs side by side facing front' },
          units_deep: { type: 'integer', description: 'Packs stacked behind each facing, estimated from shelf depth; 1 if unsure' },
          width_mm: { type: 'number' },
          height_mm: { type: 'number' },
          depth_mm: { type: 'number' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
};

function buildPrompt(hints) {
  const lines = [
    'This is a photo of a retail shelf (a pharmacy or shop). List every distinct product you can see, so a planogram with quantities can be built from it.',
    'Rules:',
    '- One entry per product (same product on the same shelf = one entry with facings counted), shelves numbered from the top as 1.',
    '- "facings" is how many packs sit side by side across the front. "units_deep" is how many packs are stacked behind each facing; use the shelf depth and pack size to estimate it, or 1 if you cannot tell.',
    '- Estimate each pack\'s real width, height and depth in millimetres from its type and size.',
    '- Do not invent products you cannot see. If a label is unreadable, describe the pack ("blue 100ml syrup bottle") and mark confidence low.',
  ];
  if (hints && hints.bayWidthMm) lines.push('- The shelf run in the photo is about ' + hints.bayWidthMm + ' mm wide; use it to scale pack sizes.');
  if (hints && hints.shelves) lines.push('- The user says there are ' + hints.shelves + ' shelves.');
  return lines.join('\n');
}

async function analyseShelfPhoto(client, image, hints) {
  const m = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/.exec(image || '');
  if (!m) throw Object.assign(new Error('Send the photo as a JPEG, PNG, GIF or WebP data URL.'), { status: 400 });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
        { type: 'text', text: buildPrompt(hints) },
      ],
    }],
  });
  if (res.stop_reason === 'refusal') throw Object.assign(new Error('The model declined to read this image.'), { status: 422 });
  if (res.stop_reason === 'max_tokens') throw Object.assign(new Error('The shelf has too many products for one pass; try a closer photo of part of it.'), { status: 422 });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try { data = JSON.parse(text); } catch (e) { throw Object.assign(new Error('Could not read the model\'s answer.'), { status: 502 }); }
  return data;
}

// Turn the model's list into engine products. Current stock is treated as the demand signal.
function toProducts(analysis, daysCover) {
  const cover = daysCover || 7;
  return analysis.products.map((p, i) => {
    const facings = Math.max(1, Math.round(p.facings));
    const deep = Math.max(1, Math.round(p.units_deep));
    return {
      sku: 'PH' + String(i + 1).padStart(3, '0'),
      name: p.name,
      category: p.category,
      width: p.width_mm, height: p.height_mm, depth: p.depth_mm,
      fixedFacings: facings, unitsDeep: deep,
      velocity: +((facings * deep) / cover).toFixed(2),
      confidence: p.confidence,
      shelfInPhoto: p.shelf,
    };
  });
}

module.exports = { MODEL, SCHEMA, analyseShelfPhoto, toProducts, buildPrompt };
