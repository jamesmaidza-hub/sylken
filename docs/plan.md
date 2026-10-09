# sylken plan

sylken can only replace Compharm once dispensing, stock, the till and BOMAid claims all work, because dispensing takes stock off the shelf. Until then it runs beside Compharm as a test system.

| Stage | Scope | Done when |
|---|---|---|
| **1. Items and stock** | Item master, stock ledger in units, Compharm import, receiving, stock take, adjustments, min/max | The 30 Sep exports load cleanly and the min/max order report matches Compharm's ✅ |
| **2. Till and cash-up** | Offline-capable till, tenders, till runs, cash-up, petty cash, customer accounts, daily sales and GP | A full day can be rung up and cashed up ✅ (tested with the Friends item list in a browser, including a spell offline) |
| **3. Dispensing** (this release) | Patients, members and dependants, doctors, scripts, labels, allergies, owed items, repeats, schedule register | A script is dispensed end to end with stock deducted ✅ (tested in a browser: captured, checked, dispensed, labelled and paid at the till) |
| 4. BOMAid claims | Claim files, member updates, real-time adjudication if offered, claim reports | BOMAid's test environment accepts claims |
| 5. Switchover | Full migration, final stock take, training, parallel run | Compharm is switched off |

## Decisions taken in stage 1

- **Multi-tenant cloud** with PostgreSQL row-level security; shop rules are settings.
- **Stock in whole units**, prices per pack. Min/max levels may be fractional.
- **Append-only ledger**; corrections are new movements. Only deleting a whole pharmacy removes ledger rows.
- **Negative stock is blocked by default** for sales, dispensing and adjustments; a pharmacist can override, and a setting allows it shop-wide. Offline till sales are always recorded, since they already happened.
- **Opening stock** comes from Compharm's exports for now: the 30 Sep min/max report where it has the item, else the 8 Oct usage report. Before switchover it must come from a fresh stock take.
- **Only items the shop has used are imported** (7,317 of 22,682); the rest of the item list is Compharm's product file. New items are added from supplier invoices.
- **Imported markups are kept per item** where they differ from the shop default (837 of the imported items at Friends), so re-pricing on receipt doesn't change them.
- **GP is shown on the price excluding VAT.** Compharm's GP % includes VAT in the price, so sylken's figures are lower for the same item.
- **No licensed reference data ships with sylken.** Each pharmacy's own item list is imported into its own tenant.

## Decisions taken in stage 2

- **The till is a browser app that works offline.** Item list, open run and sales are kept in the browser and sent when the server can be reached; ids made by the till make resending safe. A run can be opened offline; its number is given when it reaches the server.
- **A sale is recorded whatever the stock or item state says**, because it already happened. It is never edited or deleted; refunds put things right.
- **Tenders**: cash, card, cheque, EFT / direct bank, account and medical aid. Vouchers and loyalty points wait until after switchover.
- **Cash-up counts cash, card batch and cheques**; EFT is checked against the bank statement. Assistants count blind.
- **Late sales** (reaching the server after their run is cashed up) are kept, flagged and shown on the run, so a till that was offline at closing shows up as a difference rather than vanishing.
- **Sales summary** follows POSWin's layout: "cash sales" means everything paid at the till (cash, card, cheque, EFT), and runs are picked by the day they opened.
- **Medical aid at the till** is recorded as a tender with the scheme and member number. Claims come in stage 4.
- **Line prices** are the units as a fraction of the pack price, so whole packs are exact. A changed price keeps the list price beside it, and the GP report shows discounts given.

## Decisions taken in stage 3

- **A script is a draft until a pharmacist dispenses it.** Assistants may capture scripts; dispensing, reversing and handing over owed items need a pharmacist or the owner. Dispensing gives the script its number, takes the stock and freezes it. The database refuses any later change except reversal.
- **Mistakes are reversed, not edited.** Reversing puts the stock back and cancels what is still owed. A script already paid at the till must be refunded there first, and an original whose repeats were dispensed must have those reversed first.
- **Script numbers carry on from Compharm's.** The next number is a setting that can only go up.
- **Price of a script line** = the item at the shop's own price for the units prescribed, plus a dispensing fee per line (a setting, P0 until the shop sets it). Medical aid pricing and fee models come with BOMAid claims in stage 4.
- **The medical aid's share and the patient's share** are worked out when the script is dispensed. Lines marked "patient pays" (Compharm's no-claim lines) and scripts marked "patient pays" are not billed to the medical aid. The medical aid, member number and dependant code are copied onto the script then, ready for claims.
- **Scripts are paid at the till by number (F2).** The till brings the script's lines in with the medical aid share already taken as its tender, and the patient pays the rest. Those lines take no stock, because it left at dispensing. Finding a script needs the server; the rest of the till still works offline.
- **The patient is charged for the full quantity prescribed** when the script is dispensed. What isn't handed over is owed and given later at no charge, each time with its own label.
- **Repeats** are counted against the original script's lines and may be given until a set number of days after the script date (180 by default).
- **Allergies are checked by the pharmacist.** sylken has no ingredient or interaction data, so it can only spot an allergy written the way an item is named. Any script for a patient with allergies or alerts asks the pharmacist to tick that they checked them.
- **The register of scheduled medicines is read from the stock ledger**, so its balance always matches stock on hand. Which schedules go in it is a setting; none are chosen for a new pharmacy, and Friends uses schedule 1.
- **Labels** print through the browser on a label printer, one per page, at a size set in the dispensing settings (59 × 46 mm by default, Friends' label size).
- **No reference data ships**: medical aids, doctors, directions and ICD-10 codes are the shop's own. ICD-10 codes are checked for shape only. A starter list of direction codes is included, written for sylken.

## Open questions

1. Is 71.2% (50% markup plus 14% VAT) the shop's deliberate default? sylken assumes so.
2. The Oct 2025 sales file and the usage history don't reconcile; which scope does each cover? Stage 1 uses the usage history for min/max suggestions and the sales file only for pack size, bin and schedule.
3. Can Compharm give a database export? Suppliers, departments, VAT per item and patients aren't in the reports.
4. Which suppliers does the shop order from, and do any accept electronic orders?
5. Does the shop round cash to 5 or 10 thebe at the till? sylken charges to the thebe for now.
6. What must a till slip show to count as a VAT invoice for BURS? sylken prints the shop name, VAT number (set in Settings), date, items, total incl VAT and tenders.
7. How many tills, and which slip printers and card machines? The card machine isn't linked; its batch total is entered at cash-up.
8. Is direct banking (EFT) used at Friends, and are account customers given credit limits?
9. ~~Which schedules go in the register?~~ **Answered 9 Oct 2026: schedule 1** (set in Dispensing settings for Friends). Still to confirm: what each register entry must show by law; sylken records date, script number, patient name, ID and address, doctor and practice number, quantity in and out, running balance and who dispensed.
10. ~~What dispensing fee does the shop charge?~~ **Answered 9 Oct 2026: none.** The fee stays at P0; the setting is there for other pharmacies.
11. ~~How long are repeats valid?~~ **Answered 9 Oct 2026: 180 days** from the script date, which is the default.
12. What must a dispensing label show by law? Not known yet. The size is **answered 9 Oct 2026: 59 × 46 mm**. sylken prints the shop, patient, item, quantity, directions, date, script number, doctor and dispenser.
13. Should a script be priced from the shop's retail price, or from a separate dispensing price (cost plus a markup and fee)? sylken uses retail plus fee for now; stage 4 adds medical aid fee models.
14. Can Compharm's patients, doctors and script history come across in a database export?
