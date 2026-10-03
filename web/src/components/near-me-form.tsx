"use client";

import { useActionState, useState } from "react";

import { setNearMe, setStoreScope, type NearMeState } from "@/app/stores/actions";
import { NEAR_RADII } from "@/lib/postal";

/**
 * "Stores near me": a postal code and a radius, in a <details> so it stays out
 * of the way until asked for. A form posting to a server action through
 * useActionState, so it works with JavaScript off too; the details opens itself
 * when the last try failed, so the reason is never hidden behind it.
 */
export function NearMeForm({
  fsa,
  radiusKm,
  summary,
}: {
  /** The place already saved, if any. */
  fsa: string | null;
  radiusKm: number;
  summary: string;
}) {
  const [state, action, pending] = useActionState<NearMeState, FormData>(setNearMe, {
    error: null,
    postal: "",
  });
  // Open when asked for, and held open while there is an error to read. Kept in
  // state so that a later success does not close it under the visitor.
  const [asked, setAsked] = useState(false);
  return (
    <details
      className="near-details"
      open={asked || state.error !== null}
      onToggle={(event) => setAsked(event.currentTarget.open)}
    >
      <summary>{summary}</summary>
      <form action={action} className="near-form">
        <label htmlFor="near-postal">Postal code</label>
        <input
          id="near-postal"
          name="postal"
          defaultValue={state.postal}
          placeholder="e.g. L4K 0C1"
          autoComplete="postal-code"
          maxLength={12}
          required
          aria-invalid={state.error !== null ? true : undefined}
          aria-describedby={state.error !== null ? "near-error" : "near-privacy"}
        />
        <label htmlFor="near-radius" className="visually-hidden">
          Stores within
        </label>
        <select id="near-radius" name="radius" defaultValue={radiusKm}>
          {NEAR_RADII.map((km) => (
            <option key={km} value={km}>
              within {km} km
            </option>
          ))}
        </select>
        <button type="submit" disabled={pending}>
          {pending ? "Looking…" : fsa ? "Update" : "Show stores near me"}
        </button>
        {state.error !== null && (
          <p id="near-error" role="alert" className="near-error">
            {state.error}
          </p>
        )}
        <p id="near-privacy" className="near-note">
          Only the first three characters are used, and they are kept in a cookie in this browser.
          Distances are about, from the middle of each postal-code area.
        </p>
      </form>
      {fsa && (
        <form action={setStoreScope} className="near-forget">
          <button type="submit" name="scope" value="forget">
            Forget {fsa}
          </button>
        </form>
      )}
    </details>
  );
}
