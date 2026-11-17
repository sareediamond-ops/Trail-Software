-- Trail Software: database schema v1
-- Paste this whole file into the Supabase SQL editor and run it once.
-- All rules live here: the app screens can only call the functions below.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table profiles (
  id uuid primary key references auth.users (id),
  full_name text not null,
  email text not null,
  role text not null check (role in ('admin', 'staff')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid
);

create table people (
  id bigint generated always as identity primary key,
  name text not null unique,
  has_pin boolean not null default false,
  pin_locked boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid
);

-- PIN hashes sit in their own table that no client can read.
create table person_pins (
  person_id bigint primary key references people (id),
  pin_hash text not null,
  failed int not null default 0
);

create table factories (
  id bigint generated always as identity primary key,
  name text not null unique,
  active boolean not null default true
);

create table purposes (
  id bigint generated always as identity primary key,
  name text not null unique,
  is_shipment boolean not null default false,
  active boolean not null default true
);

create table pieces (
  id bigint generated always as identity primary key,
  sku text not null unique,
  photo_path text,
  state text not null default 'registered'
    check (state in ('registered', 'on_hand', 'out', 'awaiting_shipment', 'shipped', 'at_locker')),
  holder_id bigint references people (id),
  purpose_id bigint references purposes (id),
  factory_id bigint references factories (id),
  state_since timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_by uuid
);
create index pieces_state_idx on pieces (state);

-- Tracking IDs are kept apart so staff accounts can never read them.
create table shipments (
  piece_id bigint primary key references pieces (id),
  tracking_id text not null,
  entered_by uuid not null,
  entered_at timestamptz not null default now()
);

create table movements (
  id bigint generated always as identity primary key,
  batch_id uuid not null,
  piece_id bigint not null references pieces (id),
  kind text not null,
  from_state text,
  to_state text,
  person_id bigint references people (id),
  purpose_id bigint references purposes (id),
  factory_id bigint references factories (id),
  note text,
  account_id uuid not null,
  created_at timestamptz not null default now(),
  edited boolean not null default false,
  voided boolean not null default false,
  voided_by uuid,
  voided_at timestamptz,
  void_reason text
);
create index movements_piece_idx on movements (piece_id, id desc);
create index movements_created_idx on movements (created_at desc);

create table tallies (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('eod', 'handover')),
  account_id uuid not null,
  created_at timestamptz not null default now(),
  counted int not null,
  expected int not null,
  matched boolean not null,
  missing text[] not null default '{}',
  extra text[] not null default '{}',
  last_movement_id bigint
);

create table red_cards (
  id bigint generated always as identity primary key,
  kind text not null
    check (kind in ('tally_mismatch', 'locker_unaccounted', 'locker_overdue', 'out_overnight')),
  piece_id bigint references pieces (id),
  tally_id bigint references tallies (id),
  details jsonb not null default '{}',
  raised_at timestamptz not null default now(),
  raised_by uuid,
  resolved_at timestamptz,
  resolved_by uuid,
  resolve_reason text
);
create index red_cards_open_idx on red_cards (resolved_at) where resolved_at is null;

create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  account_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  old_value jsonb,
  new_value jsonb,
  reason text
);

-- The log and the movement history can never be rewritten or removed.
create function _block_change() returns trigger language plpgsql as $$
begin
  raise exception 'This record cannot be changed or deleted';
end $$;

create trigger audit_log_locked before update or delete on audit_log
  for each row execute function _block_change();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function _block_change();
create trigger movements_no_delete before delete on movements
  for each row execute function _block_change();
create trigger movements_no_truncate before truncate on movements
  for each statement execute function _block_change();

insert into purposes (name, is_shipment) values
  ('QC', false),
  ('Photoshoot (studio)', false),
  ('Vision360', false),
  ('Repairing', false),
  ('Shipment', true);

-- ---------------------------------------------------------------------------
-- Who is calling
-- ---------------------------------------------------------------------------

create function is_active_user() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active);
$$;

create function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and active and role = 'admin');
$$;

create function _require_user() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_active_user() then
    raise exception 'Your account is not active';
  end if;
end $$;

create function _require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_admin() then
    raise exception 'Only an admin can do this';
  end if;
end $$;

create function _log(p_action text, p_entity text, p_entity_id text,
                     p_old jsonb, p_new jsonb, p_reason text) returns void
language sql security definer set search_path = public as $$
  insert into audit_log (account_id, action, entity, entity_id, old_value, new_value, reason)
  values (auth.uid(), p_action, p_entity, p_entity_id, p_old, p_new, p_reason);
$$;

create function app_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'any_profiles', exists (select 1 from profiles),
    'profile', (select jsonb_build_object('full_name', full_name, 'role', role, 'active', active)
                from profiles where id = auth.uid())
  );
$$;

-- The very first signed-in user becomes the first admin. Works only once.
create function bootstrap_first_admin(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  lock table profiles in exclusive mode;
  if exists (select 1 from profiles) then
    raise exception 'The first admin already exists';
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter your name'; end if;
  select email into v_email from auth.users where id = auth.uid();
  insert into profiles (id, full_name, email, role, created_by)
  values (auth.uid(), trim(p_name), coalesce(v_email, ''), 'admin', auth.uid());
  perform _log('bootstrap_admin', 'account', auth.uid()::text, null,
               jsonb_build_object('full_name', trim(p_name), 'role', 'admin'), null);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Accounts (creating a login and resetting a password go through the
-- server function, because they need the secret key)
-- ---------------------------------------------------------------------------

create function admin_set_account(p_id uuid, p_role text, p_active boolean, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_old profiles; v_admins int;
begin
  perform _require_admin();
  if p_role not in ('admin', 'staff') then raise exception 'Role must be admin or staff'; end if;
  select * into v_old from profiles where id = p_id for update;
  if not found then raise exception 'Account not found'; end if;
  if v_old.role = 'admin' and v_old.active and (p_role <> 'admin' or not p_active) then
    select count(*) into v_admins from profiles where role = 'admin' and active;
    if v_admins <= 1 then
      raise exception 'This is the last admin. Make another admin first.';
    end if;
  end if;
  update profiles set role = p_role, active = p_active where id = p_id;
  perform _log('account_change', 'account', p_id::text,
               jsonb_build_object('role', v_old.role, 'active', v_old.active),
               jsonb_build_object('role', p_role, 'active', p_active), p_reason);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Lists: people and PINs, factories, purposes
-- ---------------------------------------------------------------------------

create function _valid_pin(p_pin text) returns void
language plpgsql immutable as $$
begin
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'A PIN must be 4 to 6 digits';
  end if;
end $$;

create function add_person(p_name text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_id bigint;
begin
  perform _require_admin();
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter a name'; end if;
  perform _valid_pin(p_pin);
  insert into people (name, has_pin, created_by) values (trim(p_name), true, auth.uid())
  returning id into v_id;
  insert into person_pins (person_id, pin_hash) values (v_id, crypt(p_pin, gen_salt('bf')));
  perform _log('person_add', 'person', v_id::text, null, jsonb_build_object('name', trim(p_name)), null);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function set_person_pin(p_id bigint, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform _require_admin();
  perform _valid_pin(p_pin);
  if not exists (select 1 from people where id = p_id) then raise exception 'Person not found'; end if;
  insert into person_pins (person_id, pin_hash, failed)
  values (p_id, crypt(p_pin, gen_salt('bf')), 0)
  on conflict (person_id) do update set pin_hash = excluded.pin_hash, failed = 0;
  update people set has_pin = true, pin_locked = false where id = p_id;
  perform _log('person_pin_reset', 'person', p_id::text, null, null, null);
  return jsonb_build_object('ok', true);
end $$;

create function set_person_active(p_id bigint, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_old boolean;
begin
  perform _require_admin();
  select active into v_old from people where id = p_id;
  if not found then raise exception 'Person not found'; end if;
  if not p_active and exists (select 1 from pieces where holder_id = p_id
                              and state in ('out', 'awaiting_shipment')) then
    raise exception 'This person still holds pieces. Take them back first.';
  end if;
  update people set active = p_active where id = p_id;
  perform _log('person_active', 'person', p_id::text,
               jsonb_build_object('active', v_old), jsonb_build_object('active', p_active), null);
  return jsonb_build_object('ok', true);
end $$;

create function add_factory(p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform _require_admin();
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter a name'; end if;
  insert into factories (name) values (trim(p_name)) returning id into v_id;
  perform _log('factory_add', 'factory', v_id::text, null, jsonb_build_object('name', trim(p_name)), null);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function set_factory_active(p_id bigint, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin();
  update factories set active = p_active where id = p_id;
  if not found then raise exception 'Factory not found'; end if;
  perform _log('factory_active', 'factory', p_id::text, null, jsonb_build_object('active', p_active), null);
  return jsonb_build_object('ok', true);
end $$;

create function add_purpose(p_name text, p_is_shipment boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform _require_admin();
  if coalesce(trim(p_name), '') = '' then raise exception 'Enter a name'; end if;
  insert into purposes (name, is_shipment) values (trim(p_name), coalesce(p_is_shipment, false))
  returning id into v_id;
  perform _log('purpose_add', 'purpose', v_id::text, null,
               jsonb_build_object('name', trim(p_name), 'is_shipment', coalesce(p_is_shipment, false)), null);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create function set_purpose_active(p_id bigint, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin();
  update purposes set active = p_active where id = p_id;
  if not found then raise exception 'Purpose not found'; end if;
  perform _log('purpose_active', 'purpose', p_id::text, null, jsonb_build_object('active', p_active), null);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- PIN check. Returns null when the PIN is right, otherwise an error object.
-- It never raises on a wrong PIN, so the failed-attempt count is kept.
-- ---------------------------------------------------------------------------

create function _pin_gate(p_person bigint, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_person people; v_pin person_pins;
begin
  select * into v_person from people where id = p_person;
  if not found or not v_person.active then
    return jsonb_build_object('ok', false, 'error', 'person', 'message', 'Pick a person from the list');
  end if;
  select * into v_pin from person_pins where person_id = p_person for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_pin',
      'message', v_person.name || ' has no PIN yet. An admin must set one.');
  end if;
  if v_pin.failed >= 5 then
    return jsonb_build_object('ok', false, 'error', 'locked',
      'message', v_person.name || '''s PIN is locked after 5 wrong tries. An admin must reset it.');
  end if;
  if p_pin is not null and v_pin.pin_hash = crypt(p_pin, v_pin.pin_hash) then
    if v_pin.failed > 0 then
      update person_pins set failed = 0 where person_id = p_person;
    end if;
    return null;
  end if;
  update person_pins set failed = failed + 1 where person_id = p_person;
  if v_pin.failed + 1 >= 5 then
    update people set pin_locked = true where id = p_person;
  end if;
  return jsonb_build_object('ok', false, 'error', 'wrong_pin',
    'message', 'Wrong PIN for ' || v_person.name || '. ' || (4 - v_pin.failed)::text || ' tries left.');
end $$;

-- ---------------------------------------------------------------------------
-- Pieces
-- ---------------------------------------------------------------------------

create function _clean_skus(p_skus text[]) returns text[]
language sql immutable as $$
  select coalesce(array_agg(distinct upper(trim(s))) filter (where trim(s) <> ''), '{}')
  from unnest(coalesce(p_skus, '{}')) s;
$$;

create function add_piece(p_sku text, p_photo_path text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_sku text := upper(trim(coalesce(p_sku, ''))); v_id bigint;
begin
  perform _require_user();
  if v_sku = '' then raise exception 'Enter a SKU'; end if;
  if exists (select 1 from pieces where sku = v_sku) then
    raise exception 'SKU % already exists', v_sku;
  end if;
  insert into pieces (sku, photo_path, created_by) values (v_sku, nullif(p_photo_path, ''), auth.uid())
  returning id into v_id;
  perform _log('piece_add', 'piece', v_sku, null, jsonb_build_object('photo_path', p_photo_path), null);
  return jsonb_build_object('ok', true, 'id', v_id, 'sku', v_sku);
end $$;

create function set_piece_photo(p_sku text, p_photo_path text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_sku text := upper(trim(coalesce(p_sku, ''))); v_old text;
begin
  perform _require_user();
  select photo_path into v_old from pieces where sku = v_sku for update;
  if not found then raise exception 'SKU % not found', v_sku; end if;
  update pieces set photo_path = nullif(p_photo_path, '') where sku = v_sku;
  perform _log('piece_photo', 'piece', v_sku, jsonb_build_object('photo_path', v_old),
               jsonb_build_object('photo_path', p_photo_path), null);
  return jsonb_build_object('ok', true);
end $$;

-- One state change for one piece, with its history row.
create function _move(p_piece pieces, p_kind text, p_to_state text, p_holder bigint,
                      p_purpose bigint, p_factory bigint, p_person bigint,
                      p_batch uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update pieces
     set state = p_to_state,
         holder_id = p_holder,
         purpose_id = p_purpose,
         factory_id = coalesce(p_factory, factory_id),
         state_since = case when state = p_to_state then state_since else now() end
   where id = p_piece.id;
  insert into movements (batch_id, piece_id, kind, from_state, to_state, person_id,
                         purpose_id, factory_id, note, account_id)
  values (p_batch, p_piece.id, p_kind, p_piece.state, p_to_state, p_person,
          p_purpose, p_factory, p_note, auth.uid());
end $$;

create function _state_label(p_state text) returns text
language sql immutable as $$
  select case p_state
    when 'registered' then 'not yet received'
    when 'on_hand' then 'on hand at desk'
    when 'out' then 'out with a person'
    when 'awaiting_shipment' then 'awaiting shipment confirmation'
    when 'shipped' then 'shipped'
    when 'at_locker' then 'at locker'
    else p_state end;
$$;

-- ---------------------------------------------------------------------------
-- Desk moves
-- ---------------------------------------------------------------------------

-- Incoming: new pieces from a factory. A SKU that does not exist yet is created.
create function receive_from_factory(p_factory bigint, p_person bigint, p_pin text, p_skus text[])
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_skus text[] := _clean_skus(p_skus); v_sku text; v_piece pieces;
        v_batch uuid := gen_random_uuid(); v_gate jsonb;
begin
  perform _require_user();
  if cardinality(v_skus) = 0 then raise exception 'Add at least one SKU'; end if;
  if not exists (select 1 from factories where id = p_factory and active) then
    raise exception 'Pick a factory from the list';
  end if;
  foreach v_sku in array v_skus loop
    select * into v_piece from pieces where sku = v_sku;
    if found and v_piece.state <> 'registered' then
      raise exception 'SKU % is already in the system (%)', v_sku, _state_label(v_piece.state);
    end if;
  end loop;
  v_gate := _pin_gate(p_person, p_pin);
  if v_gate is not null then return v_gate; end if;
  foreach v_sku in array v_skus loop
    select * into v_piece from pieces where sku = v_sku for update;
    if not found then
      insert into pieces (sku, created_by) values (v_sku, auth.uid()) returning * into v_piece;
    end if;
    perform _move(v_piece, 'incoming', 'on_hand', null, null, p_factory, p_person, v_batch, null);
  end loop;
  return jsonb_build_object('ok', true, 'count', cardinality(v_skus));
end $$;

-- Outgoing: hand pieces to a person for a purpose. A shipment purpose puts
-- them in "awaiting shipment confirmation" instead of "out".
create function issue_pieces(p_person bigint, p_pin text, p_purpose bigint, p_skus text[])
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_skus text[] := _clean_skus(p_skus); v_sku text; v_piece pieces;
        v_batch uuid := gen_random_uuid(); v_gate jsonb; v_purpose purposes;
begin
  perform _require_user();
  if cardinality(v_skus) = 0 then raise exception 'Add at least one SKU'; end if;
  select * into v_purpose from purposes where id = p_purpose and active;
  if not found then raise exception 'Pick a purpose from the list'; end if;
  foreach v_sku in array v_skus loop
    select * into v_piece from pieces where sku = v_sku;
    if not found then raise exception 'SKU % not found', v_sku; end if;
    if v_piece.state <> 'on_hand' then
      raise exception 'SKU % is not on hand (%)', v_sku, _state_label(v_piece.state);
    end if;
  end loop;
  v_gate := _pin_gate(p_person, p_pin);
  if v_gate is not null then return v_gate; end if;
  foreach v_sku in array v_skus loop
    select * into v_piece from pieces where sku = v_sku for update;
    if v_piece.state <> 'on_hand' then
      raise exception 'SKU % is not on hand (%)', v_sku, _state_label(v_piece.state);
    end if;
    perform _move(v_piece,
                  case when v_purpose.is_shipment then 'ship_handover' else 'issue' end,
                  case when v_purpose.is_shipment then 'awaiting_shipment' else 'out' end,
                  p_person, p_purpose, null, p_person, v_batch, null);
  end loop;
  return jsonb_build_object('ok', true, 'count', cardinality(v_skus));
end $$;

-- Return: the person brings pieces back to the desk.
create function return_pieces(p_person bigint, p_pin text, p_skus text[])
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_skus text[] := _clean_skus(p_skus); v_sku text; v_piece pieces;
        v_batch uuid := gen_random_uuid(); v_gate jsonb;
begin
  perform _require_user();
  if cardinality(v_skus) = 0 then raise exception 'Add at least one SKU'; end if;
  foreach v_sku in array v_skus loop
    select * into v_piece from pieces where sku = v_sku;
    if not found then raise exception 'SKU % not found', v_sku; end if;
    if v_piece.state not in ('out', 'awaiting_shipment') or v_piece.holder_id is distinct from p_person then
      raise exception 'SKU % is not with this person', v_sku;
    end if;
  end loop;
  v_gate := _pin_gate(p_person, p_pin);
  if v_gate is not null then return v_gate; end if;
  foreach v_sku in array v_skus loop
    select * into v_piece from pieces where sku = v_sku for update;
    if v_piece.state not in ('out', 'awaiting_shipment') or v_piece.holder_id is distinct from p_person then
      raise exception 'SKU % is not with this person', v_sku;
    end if;
    perform _move(v_piece,
                  case when v_piece.state = 'awaiting_shipment' then 'ship_return' else 'return' end,
                  'on_hand', null, null, null, p_person, v_batch, null);
  end loop;
  return jsonb_build_object('ok', true, 'count', cardinality(v_skus));
end $$;

-- Admin only: the tracking ID closes the shipment. Many pieces may share one ID.
create function mark_shipped(p_skus text[], p_tracking text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_skus text[] := _clean_skus(p_skus); v_sku text; v_piece pieces;
        v_batch uuid := gen_random_uuid(); v_tracking text := trim(coalesce(p_tracking, ''));
begin
  perform _require_admin();
  if cardinality(v_skus) = 0 then raise exception 'Pick at least one piece'; end if;
  if v_tracking = '' then raise exception 'Enter the tracking ID'; end if;
  foreach v_sku in array v_skus loop
    select * into v_piece from pieces where sku = v_sku for update;
    if not found then raise exception 'SKU % not found', v_sku; end if;
    if v_piece.state <> 'awaiting_shipment' then
      raise exception 'SKU % is not awaiting shipment (%)', v_sku, _state_label(v_piece.state);
    end if;
    insert into shipments (piece_id, tracking_id, entered_by) values (v_piece.id, v_tracking, auth.uid());
    perform _move(v_piece, 'shipped', 'shipped', v_piece.holder_id, v_piece.purpose_id,
                  null, v_piece.holder_id, v_batch, null);
  end loop;
  return jsonb_build_object('ok', true, 'count', cardinality(v_skus));
end $$;

-- ---------------------------------------------------------------------------
-- Red cards
-- ---------------------------------------------------------------------------

create function _raise_card(p_kind text, p_piece bigint, p_tally bigint, p_details jsonb)
returns void
language sql security definer set search_path = public as $$
  insert into red_cards (kind, piece_id, tally_id, details, raised_by)
  values (p_kind, p_piece, p_tally, coalesce(p_details, '{}'), auth.uid());
$$;

-- Raises the time-based cards. The app calls this whenever the dashboard opens.
--   out_overnight : a piece still out with a person from an earlier day (once a day)
--   locker_overdue: a piece at the locker for more than 3 days (returns 3 days
--                   after it was last resolved, if the piece is still there)
create function refresh_cards() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_today date := (now() at time zone 'Asia/Kolkata')::date; r record; v_n int := 0;
begin
  perform _require_user();
  for r in
    select p.id, p.sku, p.holder_id, p.purpose_id, p.state_since
      from pieces p
     where p.state = 'out'
       and (p.state_since at time zone 'Asia/Kolkata')::date < v_today
       and not exists (
         select 1 from red_cards c
          where c.piece_id = p.id and c.kind = 'out_overnight'
            and (c.resolved_at is null
                 or (c.raised_at at time zone 'Asia/Kolkata')::date = v_today))
  loop
    perform _raise_card('out_overnight', r.id, null, jsonb_build_object(
      'sku', r.sku, 'person_id', r.holder_id, 'purpose_id', r.purpose_id, 'since', r.state_since));
    v_n := v_n + 1;
  end loop;
  for r in
    select p.id, p.sku, p.holder_id, p.state_since
      from pieces p
     where p.state = 'at_locker'
       and p.state_since < now() - interval '3 days'
       and not exists (
         select 1 from red_cards c
          where c.piece_id = p.id and c.kind = 'locker_overdue'
            and (c.resolved_at is null or c.resolved_at > now() - interval '3 days'))
  loop
    perform _raise_card('locker_overdue', r.id, null, jsonb_build_object(
      'sku', r.sku, 'carried_by', r.holder_id, 'since', r.state_since,
      'last_source', (select m.person_id from movements m
                       where m.piece_id = r.id and m.kind = 'locker_stay' and not m.voided
                       order by m.id desc limit 1)));
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'raised', v_n);
end $$;

create function resolve_card(p_id bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform _require_admin();
  if coalesce(trim(p_reason), '') = '' then raise exception 'Write a reason'; end if;
  update red_cards set resolved_at = now(), resolved_by = auth.uid(), resolve_reason = trim(p_reason)
   where id = p_id and resolved_at is null;
  if not found then raise exception 'Card not found or already resolved'; end if;
  perform _log('card_resolve', 'red_card', p_id::text, null, null, trim(p_reason));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Tally, locker, morning
-- ---------------------------------------------------------------------------

-- The desk enters its own count and SKUs first; only then does the software compare.
create function desk_tally(p_kind text, p_count int, p_skus text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_entered text[] := _clean_skus(p_skus); v_expected text[]; v_missing text[]; v_extra text[];
        v_matched boolean; v_id bigint; r record;
begin
  perform _require_user();
  if p_kind not in ('eod', 'handover') then raise exception 'Unknown tally kind'; end if;
  if p_count is null or p_count < 0 then raise exception 'Enter the physical count'; end if;
  select coalesce(array_agg(sku order by sku), '{}') into v_expected from pieces where state = 'on_hand';
  select coalesce(array_agg(s order by s), '{}') into v_missing
    from unnest(v_expected) s where s <> all (v_entered);
  select coalesce(array_agg(s order by s), '{}') into v_extra
    from unnest(v_entered) s where s <> all (v_expected);
  v_matched := cardinality(v_missing) = 0 and cardinality(v_extra) = 0
               and p_count = cardinality(v_expected);
  insert into tallies (kind, account_id, counted, expected, matched, missing, extra, last_movement_id)
  values (p_kind, auth.uid(), p_count, cardinality(v_expected), v_matched, v_missing, v_extra,
          (select max(id) from movements))
  returning id into v_id;
  if not v_matched then
    perform _raise_card('tally_mismatch', null, v_id, jsonb_build_object(
      'kind', p_kind, 'counted', p_count, 'expected', cardinality(v_expected),
      'extra', to_jsonb(v_extra),
      'missing', (select coalesce(jsonb_agg(jsonb_build_object(
                    'sku', p.sku,
                    'last_person', (select m.person_id from movements m
                                     where m.piece_id = p.id and m.person_id is not null and not m.voided
                                     order by m.id desc limit 1))), '[]')
                    from pieces p where p.sku = any (v_missing))));
  end if;
  if p_kind = 'eod' then
    -- No piece may stay out overnight.
    for r in
      select p.id, p.sku, p.holder_id, p.purpose_id, p.state_since from pieces p
       where p.state = 'out'
         and not exists (select 1 from red_cards c where c.piece_id = p.id
                          and c.kind = 'out_overnight' and c.resolved_at is null)
    loop
      perform _raise_card('out_overnight', r.id, null, jsonb_build_object(
        'sku', r.sku, 'person_id', r.holder_id, 'purpose_id', r.purpose_id, 'since', r.state_since));
    end loop;
  end if;
  return jsonb_build_object('ok', true, 'matched', v_matched, 'tally_id', v_id,
                            'missing', to_jsonb(v_missing), 'extra', to_jsonb(v_extra),
                            'expected', cardinality(v_expected));
end $$;

-- After a matching end-of-day tally, everything on hand goes to the locker.
create function send_to_locker(p_person bigint, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_tally tallies; v_piece pieces; v_batch uuid := gen_random_uuid(); v_gate jsonb; v_n int := 0;
begin
  perform _require_user();
  select * into v_tally from tallies where kind = 'eod' order by id desc limit 1;
  if not found or not v_tally.matched or v_tally.created_at < now() - interval '2 hours' then
    raise exception 'Do a matching end-of-day tally first';
  end if;
  if (select max(id) from movements) is distinct from v_tally.last_movement_id then
    raise exception 'Stock changed after the tally. Do the tally again.';
  end if;
  if not exists (select 1 from pieces where state = 'on_hand') then
    raise exception 'Nothing is on hand to send to the locker';
  end if;
  v_gate := _pin_gate(p_person, p_pin);
  if v_gate is not null then return v_gate; end if;
  for v_piece in select * from pieces where state = 'on_hand' order by sku for update loop
    perform _move(v_piece, 'to_locker', 'at_locker', p_person, null, null, p_person, v_batch, null);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'count', v_n);
end $$;

-- Morning: every locker piece is marked arrived, still at locker, or missing.
create function morning_locker(p_arrived text[], p_stay text[], p_missing text[],
                               p_carrier bigint, p_pin text, p_source bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_arrived text[] := _clean_skus(p_arrived); v_stay text[] := _clean_skus(p_stay);
        v_missing text[] := _clean_skus(p_missing); v_all text[]; v_sku text; v_piece pieces;
        v_batch uuid := gen_random_uuid(); v_gate jsonb;
begin
  perform _require_user();
  v_all := v_arrived || v_stay || v_missing;
  if cardinality(v_all) = 0 then raise exception 'Mark at least one piece'; end if;
  if cardinality(v_all) <> cardinality(_clean_skus(v_all)) then
    raise exception 'A piece can have only one mark';
  end if;
  foreach v_sku in array v_all loop
    select * into v_piece from pieces where sku = v_sku;
    if not found or v_piece.state <> 'at_locker' then
      raise exception 'SKU % is not at the locker', v_sku;
    end if;
  end loop;
  if cardinality(v_stay) > 0
     and not exists (select 1 from people where id = p_source and active) then
    raise exception 'Pick who said the pieces are still at the locker';
  end if;
  if cardinality(v_arrived) > 0 then
    v_gate := _pin_gate(p_carrier, p_pin);
    if v_gate is not null then return v_gate; end if;
  end if;
  foreach v_sku in array v_arrived loop
    select * into v_piece from pieces where sku = v_sku for update;
    perform _move(v_piece, 'locker_arrived', 'on_hand', null, null, null, p_carrier, v_batch, null);
  end loop;
  foreach v_sku in array v_stay loop
    select * into v_piece from pieces where sku = v_sku for update;
    perform _move(v_piece, 'locker_stay', 'at_locker', v_piece.holder_id, null, null, p_source, v_batch, null);
  end loop;
  foreach v_sku in array v_missing loop
    select * into v_piece from pieces where sku = v_sku;
    if not exists (select 1 from red_cards c where c.piece_id = v_piece.id
                    and c.kind = 'locker_unaccounted' and c.resolved_at is null) then
      perform _raise_card('locker_unaccounted', v_piece.id, null, jsonb_build_object(
        'sku', v_sku, 'carried_by', v_piece.holder_id, 'since', v_piece.state_since));
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'arrived', cardinality(v_arrived),
                            'stay', cardinality(v_stay), 'missing', cardinality(v_missing));
end $$;

-- ---------------------------------------------------------------------------
-- Admin corrections. Nothing is ever erased: the old value stays in the log.
-- ---------------------------------------------------------------------------

create function void_movement(p_id bigint, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_old movements;
begin
  perform _require_admin();
  if coalesce(trim(p_reason), '') = '' then raise exception 'Write a reason'; end if;
  select * into v_old from movements where id = p_id for update;
  if not found then raise exception 'Entry not found'; end if;
  if v_old.voided then raise exception 'Entry is already struck through'; end if;
  update movements set voided = true, voided_by = auth.uid(), voided_at = now(),
                       void_reason = trim(p_reason) where id = p_id;
  perform _log('entry_delete', 'movement', p_id::text, to_jsonb(v_old), null, trim(p_reason));
  return jsonb_build_object('ok', true);
end $$;

create function edit_movement(p_id bigint, p_person bigint, p_purpose bigint, p_factory bigint,
                              p_note text, p_reason text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_old movements; v_new movements;
begin
  perform _require_admin();
  if coalesce(trim(p_reason), '') = '' then raise exception 'Write a reason'; end if;
  select * into v_old from movements where id = p_id for update;
  if not found then raise exception 'Entry not found'; end if;
  update movements set person_id = p_person, purpose_id = p_purpose, factory_id = p_factory,
                       note = nullif(trim(coalesce(p_note, '')), ''), edited = true
   where id = p_id returning * into v_new;
  perform _log('entry_edit', 'movement', p_id::text,
               jsonb_build_object('person_id', v_old.person_id, 'purpose_id', v_old.purpose_id,
                                  'factory_id', v_old.factory_id, 'note', v_old.note),
               jsonb_build_object('person_id', v_new.person_id, 'purpose_id', v_new.purpose_id,
                                  'factory_id', v_new.factory_id, 'note', v_new.note),
               trim(p_reason));
  return jsonb_build_object('ok', true);
end $$;

-- A correction is a new entry that puts a piece into the right state.
create function correct_piece(p_sku text, p_state text, p_holder bigint, p_purpose bigint, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_sku text := upper(trim(coalesce(p_sku, ''))); v_piece pieces;
begin
  perform _require_admin();
  if coalesce(trim(p_reason), '') = '' then raise exception 'Write a reason'; end if;
  if p_state not in ('registered', 'on_hand', 'out', 'awaiting_shipment', 'at_locker') then
    raise exception 'A correction cannot set this state';
  end if;
  if p_state in ('out', 'awaiting_shipment', 'at_locker')
     and not exists (select 1 from people where id = p_holder) then
    raise exception 'Pick the person holding the piece';
  end if;
  select * into v_piece from pieces where sku = v_sku for update;
  if not found then raise exception 'SKU % not found', v_sku; end if;
  if v_piece.state = 'shipped' then
    delete from shipments where piece_id = v_piece.id;
  end if;
  perform _move(v_piece, 'correction', p_state,
                case when p_state in ('out', 'awaiting_shipment', 'at_locker') then p_holder end,
                case when p_state in ('out', 'awaiting_shipment') then p_purpose end,
                null, p_holder, gen_random_uuid(), trim(p_reason));
  perform _log('correction', 'piece', v_sku,
               jsonb_build_object('state', v_piece.state, 'holder_id', v_piece.holder_id),
               jsonb_build_object('state', p_state, 'holder_id', p_holder), trim(p_reason));
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- Access rules: clients may only read. Every write goes through a function.
-- ---------------------------------------------------------------------------

alter table profiles enable row level security;
alter table people enable row level security;
alter table person_pins enable row level security;
alter table factories enable row level security;
alter table purposes enable row level security;
alter table pieces enable row level security;
alter table shipments enable row level security;
alter table movements enable row level security;
alter table tallies enable row level security;
alter table red_cards enable row level security;
alter table audit_log enable row level security;

create policy read_profiles on profiles for select to authenticated using (is_active_user());
create policy read_people on people for select to authenticated using (is_active_user());
create policy read_factories on factories for select to authenticated using (is_active_user());
create policy read_purposes on purposes for select to authenticated using (is_active_user());
create policy read_pieces on pieces for select to authenticated using (is_active_user());
create policy read_movements on movements for select to authenticated using (is_active_user());
create policy read_tallies on tallies for select to authenticated using (is_active_user());
create policy read_red_cards on red_cards for select to authenticated using (is_active_user());
create policy read_shipments on shipments for select to authenticated using (is_admin());
create policy read_audit_log on audit_log for select to authenticated using (is_admin());
-- person_pins has no policy on purpose: nobody can read it.

revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;
revoke all on person_pins from authenticated;

revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;
revoke execute on function _require_user(), _require_admin(),
  _log(text, text, text, jsonb, jsonb, text),
  _pin_gate(bigint, text),
  _move(pieces, text, text, bigint, bigint, bigint, bigint, uuid, text),
  _raise_card(text, bigint, bigint, jsonb),
  _block_change()
  from authenticated;

-- === STORAGE ===
-- Private bucket for piece photos. Signed-in, active accounts can add and view.

insert into storage.buckets (id, name, public)
values ('piece-photos', 'piece-photos', false)
on conflict (id) do nothing;

create policy "piece photos read" on storage.objects for select to authenticated
  using (bucket_id = 'piece-photos' and public.is_active_user());
create policy "piece photos add" on storage.objects for insert to authenticated
  with check (bucket_id = 'piece-photos' and public.is_active_user());
