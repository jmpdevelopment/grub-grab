/** Grey placeholder cards shown while the first load is on its way, instead of a misleading "empty" message. */
export function LoadingCards({ label }: { label: string }) {
  return (
    <div className="loading-cards" role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {[0, 1, 2].map((n) => (
        <div key={n} className="skeleton-card" aria-hidden />
      ))}
    </div>
  )
}
