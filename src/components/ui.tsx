import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost'

const variants: Record<Variant, string> = {
  primary: 'bg-brand-500 text-white hover:bg-brand-600 disabled:bg-brand-500/50',
  secondary: 'bg-navy-50 text-navy-900 hover:bg-navy-100 disabled:opacity-50',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-600/50',
  ghost: 'bg-transparent text-navy-800 hover:bg-navy-50 disabled:opacity-50',
}

export function Button({
  variant = 'primary',
  className = '',
  busy,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 font-semibold transition-colors ${variants[variant]} ${className}`}
      disabled={busy || props.disabled}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy && <Spinner small />}
      {children}
    </button>
  )
}

export function LinkButton({ to, variant = 'primary', className = '', children }: { to: string; variant?: Variant; className?: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2 font-semibold transition-colors ${variants[variant]} ${className}`}
    >
      {children}
    </Link>
  )
}

export function Card({ children, className = '', tone }: { children: ReactNode; className?: string; tone?: 'green' | 'amber' | 'red' | 'blue' }) {
  const tones = {
    green: 'bg-brand-50 border-brand-100',
    amber: 'bg-amber-50 border-amber-200',
    red: 'bg-red-50 border-red-200',
    blue: 'bg-navy-50 border-navy-100',
  }
  return <div className={`rounded-2xl border p-4 shadow-sm ${tone ? tones[tone] : 'border-slate-200 bg-white'} ${className}`}>{children}</div>
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-navy-900">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

const inputClass =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-navy-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-100'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputClass} ${props.className ?? ''}`} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputClass} ${props.className ?? ''}`} />
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputClass} ${props.className ?? ''}`} />
}

export function Spinner({ small }: { small?: boolean }) {
  return (
    <span
      role="status"
      aria-label="…"
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent ${small ? 'h-4 w-4' : 'h-8 w-8'}`}
    />
  )
}

export function Loading() {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-navy-600">
      <Spinner />
      <span>{t('common.loading')}</span>
    </div>
  )
}

export function ErrorBox({ error, onRetry }: { error: { code: string } | null | undefined; onRetry?: () => void }) {
  const { t } = useTranslation()
  if (!error) return null
  return (
    <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
      <p>{t(`errors.${error.code}`, { defaultValue: t('errors.unknown_error') })}</p>
      {onRetry && (
        <button type="button" className="mt-2 font-semibold underline" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-slate-500">{children}</p>
}

export function Badge({ children, tone = 'gray' }: { children: ReactNode; tone?: 'gray' | 'green' | 'amber' | 'red' | 'blue' }) {
  const tones = {
    gray: 'bg-slate-100 text-slate-700',
    green: 'bg-brand-100 text-brand-700',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-red-100 text-red-700',
    blue: 'bg-navy-100 text-navy-800',
  }
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${tones[tone]}`}>{children}</span>
}

const AVATAR_COLORS = ['bg-navy-600', 'bg-brand-600', 'bg-amber-600', 'bg-rose-600', 'bg-sky-600', 'bg-violet-600', 'bg-teal-600']

export function Avatar({ name, id, size = 'md' }: { name: string; id: string; size?: 'sm' | 'md' }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
  const color = AVATAR_COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length]
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white ${color} ${size === 'sm' ? 'h-8 w-8 text-xs' : 'h-11 w-11 text-sm'}`}
    >
      {initials || '?'}
    </span>
  )
}

export function PageHeader({ title, subtitle, back, action }: { title: string; subtitle?: string; back?: string; action?: ReactNode }) {
  const { t } = useTranslation()
  return (
    <header className="mb-4 flex items-center gap-2">
      {back && (
        <Link to={back} aria-label={t('common.back')} className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-2xl hover:bg-navy-50">
          ‹
        </Link>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-2xl font-extrabold text-navy-900">{title}</h1>
        {subtitle && <p className="truncate text-sm text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </header>
  )
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-navy-900">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}
