-- Seed data in the 0001 schema, used by scripts/verify-migration.sh.
INSERT INTO groups (id, name, currency) VALUES ('gggggggggggggggggggggg', 'Seed trip', 'THB');
INSERT INTO members (id, group_id, name, position) VALUES
  ('mmmmmmmmmmmmmmm1', 'gggggggggggggggggggggg', 'Ann', 0),
  ('mmmmmmmmmmmmmmm2', 'gggggggggggggggggggggg', 'Ben', 1);
INSERT INTO bills (id, group_id, kind, description, amount, paid_by, date, split_mode) VALUES
  ('bbbbbbbbbbbbbbb1', 'gggggggggggggggggggggg', 'expense', 'Hotel', 1000, 'mmmmmmmmmmmmmmm1', '2026-10-01', 'equal'),
  ('bbbbbbbbbbbbbbb2', 'gggggggggggggggggggggg', 'payment', 'Payment', 500, 'mmmmmmmmmmmmmmm2', '2026-10-02', 'equal');
INSERT INTO bill_shares (bill_id, member_id, amount) VALUES
  ('bbbbbbbbbbbbbbb1', 'mmmmmmmmmmmmmmm1', 500),
  ('bbbbbbbbbbbbbbb1', 'mmmmmmmmmmmmmmm2', 500),
  ('bbbbbbbbbbbbbbb2', 'mmmmmmmmmmmmmmm1', 500);
