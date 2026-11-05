// packages/shared/src/utils/phone.ts — flexible Pakistani phone input.
//
// Users type their number every way imaginable. This normalizes to the
// canonical +92XXXXXXXXXX form used in storage, and — just as importantly —
// explains WHY a number was rejected so the UI can tell them instead of
// silently disabling the submit button.
//
// Accepted (all become +923001234567):
//   3001234567          bare 10-digit
//   03001234567         national, leading 0
//   923001234567        country code, no plus
//   +923001234567       full international
//   00923001234567      international with 00 trunk prefix
//   +92 0300 1234567    country code AND national 0 (people do this a lot)
//   0300-1234567 / "0300 1234567" / " 0300.1234567 "  any punctuation/spacing

/** Pakistani mobile numbers are 10 digits beginning with 3 (03xx networks). */
const SUBSCRIBER = /^3\d{9}$/;

/**
 * Reduce any input to the 10-digit subscriber number, or null.
 * Kept separate so `normalizePhone` and `describePhoneProblem` cannot drift.
 */
function toSubscriber(input: string): string | null {
  if (!input) return null;
  let d = input.replace(/\D/g, '');
  if (!d) return null;

  // 00 international trunk prefix: 0092… -> 92…
  if (d.startsWith('00')) d = d.slice(2);
  // country code
  if (d.startsWith('92')) d = d.slice(2);
  // national trunk 0 — may appear on its own OR after the country code
  // (+92 0300 1234567), which the old parser rejected outright.
  if (d.startsWith('0')) d = d.replace(/^0+/, '');

  return SUBSCRIBER.test(d) ? d : null;
}

export function normalizePhone(input: string): string | null {
  const sub = toSubscriber(input);
  return sub ? `+92${sub}` : null;
}

/**
 * Human explanation of why a number isn't usable, or null when it is fine.
 *
 * The login button used to be `disabled` whenever normalizePhone() returned
 * null, so a user whose number this parser didn't understand saw a dead button
 * and no reason. Now the form always submits and shows one of these.
 */
export function describePhoneProblem(input: string): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return 'Enter your mobile number';

  const digits = raw.replace(/\D/g, '');
  if (!digits) return 'Enter your mobile number using digits';

  if (toSubscriber(raw)) return null;

  // strip the prefixes the same way, then judge what's left
  let d = digits;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('92')) d = d.slice(2);
  d = d.replace(/^0+/, '');

  if (d.length < 10)
    return `That number looks too short — Pakistani mobiles have 10 digits after the 0 (e.g. 0300 1234567)`;
  if (d.length > 10)
    return `That number looks too long — Pakistani mobiles have 10 digits after the 0 (e.g. 0300 1234567)`;
  if (!d.startsWith('3'))
    return 'Pakistani mobile numbers start with 3 after the 0 (e.g. 0300, 0321, 0345)';
  return 'Enter a valid Pakistani mobile number (e.g. 0300 1234567)';
}

/** Pretty display form: +92 300 1234567 */
export function formatPhone(input: string): string {
  const n = normalizePhone(input);
  if (!n) return input;
  return `+92 ${n.slice(3, 6)} ${n.slice(6)}`;
}

/** Loose check for live UI feedback (doesn't require full validity). */
export function phoneLooksValid(input: string): boolean {
  return toSubscriber(input) !== null;
}
