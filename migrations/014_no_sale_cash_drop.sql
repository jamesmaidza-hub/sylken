-- No-sale (the drawer is opened without a sale, with a reason) and cash drops (cash taken out of the drawer to the safe
-- or a supervisor) at the till. Both are till entries, so they sync, can be rung up offline, and are counted per run.
--   * a cash drop is cash that leaves the drawer: it lowers the cash the drawer is expected to hold at cash-up
--   * a no-sale moves no money (amount 0) but is a high-priority event in the audit log

alter table till_entries drop constraint if exists till_entries_kind_check;
alter table till_entries add constraint till_entries_kind_check
  check (kind in ('petty_cash','account_payment','cash_drop','no_sale'));

alter table till_entries drop constraint if exists till_entries_amount_check;
alter table till_entries add constraint till_entries_amount_check
  check (amount > 0 or kind = 'no_sale');

alter table till_entries
  add column reason       text check (reason in ('change','count','error','other')),   -- no-sale reason code
  add column cashier_code text check (cashier_code ~ '^[A-Z]{2}$');                      -- the staff code typed for the event

alter table tenant_settings
  add column cash_drop_limit numeric(12,2) not null default 0 check (cash_drop_limit >= 0);   -- 0 = no alert
