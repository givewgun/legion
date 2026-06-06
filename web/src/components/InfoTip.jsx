// Small ℹ️ marker that reveals a tooltip on hover or keyboard focus.
// Uses group-hover + focus-within so it works for mouse and keyboard users.
export function InfoTip({ label, title, children }) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={`What is ${label}?`}
        className="ml-1 h-4 w-4 cursor-help rounded-full border border-slate-300 text-[10px] leading-none text-slate-500 hover:border-slate-400 hover:text-slate-700 focus:outline-none focus:ring-1 focus:ring-slate-400"
      >
        i
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-6 z-10 w-56 -translate-x-1/2 rounded-md border border-slate-200 bg-white p-2 text-left text-xs font-normal text-slate-600 opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {title && <span className="mb-0.5 block font-semibold text-slate-800">{title}</span>}
        {children}
      </span>
    </span>
  );
}
