-- TravelSplit money primitives. Mirrors src/domain/money exactly (integer arithmetic only).
-- Any change here must be mirrored in TypeScript; tests/integration/money-parity.test.ts compares both.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

-- ISO 4217 minor-unit exponent; null for unsupported currencies.
create or replace function public.currency_exponent(p_currency text)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_currency = any(array['BIF','CLP','DJF','GNF','ISK','JPY','KMF','KRW','PYG','RWF','UGX','VND','VUV','XAF','XOF','XPF']) then 0
    when p_currency = any(array['BHD','IQD','JOD','KWD','LYD','OMR','TND']) then 3
    when p_currency = any(array['AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN','BAM','BBD','BDT','BGN','BMD','BND','BOB','BRL','BSD','BTN','BWP','BYN','BZD','CAD','CDF','CHF','CNY','COP','CRC','CUP','CVE','CZK','DKK','DOP','DZD','EGP','ERN','ETB','EUR','FJD','FKP','GBP','GEL','GHS','GIP','GMD','GTQ','GYD','HKD','HNL','HTG','HUF','IDR','ILS','INR','IRR','JMD','KES','KGS','KHR','KPW','KYD','KZT','LAK','LBP','LKR','LRD','LSL','MAD','MDL','MGA','MKD','MMK','MNT','MOP','MRU','MUR','MVR','MWK','MXN','MYR','MZN','NAD','NGN','NIO','NOK','NPR','NZD','PAB','PEN','PGK','PHP','PKR','PLN','QAR','RON','RSD','RUB','SAR','SBD','SCR','SDG','SEK','SGD','SHP','SLE','SOS','SRD','SSP','STN','SVC','SYP','SZL','THB','TJS','TMT','TOP','TRY','TTD','TWD','TZS','UAH','USD','UYU','UZS','VES','WST','XCD','YER','ZAR','ZMW','ZWG']) then 2
    else null
  end
$$;

-- Round numerator/denominator half-up (both non-negative, denominator > 0).
create or replace function private.div_round_half_up(p_num numeric, p_den numeric)
returns bigint
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
begin
  if p_den <= 0 then raise exception 'invalid_denominator' using errcode = '22012'; end if;
  if p_num < 0 then raise exception 'negative_value' using errcode = '22003'; end if;
  return div(2 * p_num + p_den, 2 * p_den)::bigint;
end;
$$;

-- Rates are numeric(20,10) EUR per unit. Scaled integer = rate * 10^10.
-- base_minor = round(minor * from_rate * 10^e_base / (10^e_from * base_rate)), half-up, once.
create or replace function public.convert_minor(
  p_minor bigint, p_from text, p_base text, p_from_rate numeric, p_base_rate numeric
)
returns bigint
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  e_from integer := public.currency_exponent(p_from);
  e_base integer := public.currency_exponent(p_base);
begin
  if e_from is null or e_base is null then raise exception 'unsupported_currency'; end if;
  if p_minor < 0 then raise exception 'negative_value'; end if;
  if p_from = p_base then return p_minor; end if;
  if p_from_rate is null or p_base_rate is null then raise exception 'missing_fx_rate'; end if;
  return private.div_round_half_up(
    p_minor::numeric * (p_from_rate * 10000000000)::numeric * (10::numeric ^ e_base),
    (10::numeric ^ e_from) * (p_base_rate * 10000000000)::numeric
  );
end;
$$;

-- Largest remainder allocation; ties broken by array position (callers order by person id).
create or replace function public.allocate_largest_remainder(p_total bigint, p_weights bigint[])
returns bigint[]
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  n integer := coalesce(array_length(p_weights, 1), 0);
  w_sum numeric := 0;
  parts bigint[] := '{}';
  missing numeric;
  r record;
begin
  if p_total < 0 then raise exception 'negative_value'; end if;
  if n = 0 then raise exception 'no_participants'; end if;
  for i in 1..n loop
    if p_weights[i] < 0 then raise exception 'negative_weight'; end if;
    w_sum := w_sum + p_weights[i];
  end loop;
  if w_sum = 0 then raise exception 'zero_weights'; end if;

  for i in 1..n loop
    parts := parts || div(p_total::numeric * p_weights[i], w_sum)::bigint;
  end loop;
  missing := p_total - (select sum(x) from unnest(parts) as x);

  for r in
    select idx, mod(p_total::numeric * p_weights[idx], w_sum) as rest
    from generate_series(1, n) as idx
    order by mod(p_total::numeric * p_weights[idx], w_sum) desc, idx asc
  loop
    exit when missing = 0;
    continue when r.rest = 0 and p_weights[r.idx] = 0;
    parts[r.idx] := parts[r.idx] + 1;
    missing := missing - 1;
  end loop;
  return parts;
end;
$$;

grant execute on function public.currency_exponent(text) to anon, authenticated;
grant execute on function public.convert_minor(bigint, text, text, numeric, numeric) to authenticated;
grant execute on function public.allocate_largest_remainder(bigint, bigint[]) to authenticated;
