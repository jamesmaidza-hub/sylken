-- A supervisor role between cashier and manager: runs the floor, cashes up, books in and adjusts stock.
-- (The "assistant" role is shown as "Cashier"; its stored name stays assistant.)
alter table users drop constraint users_roles_valid;
alter table users add constraint users_roles_valid
  check (cardinality(roles) > 0 and roles <@ array['assistant','supervisor','dispenser','pharmacist','manager']::text[]);
