import { cn } from '@/lib/utils';

/**
 * Image-or-initials avatar. Renders the photo when `src` (a data URL or http
 * URL) is set, otherwise the deterministic initials gradient lifted from the
 * marketplace card. Shared by the marketplace, chat, and the top bar so a user's
 * face/initials look identical everywhere.
 */
const HUES = [
  'from-blue-500 to-violet-600',
  'from-emerald-500 to-teal-600',
  'from-orange-500 to-red-600',
  'from-pink-500 to-rose-600',
];

export function Avatar({
  name,
  src,
  size = 48,
  className,
}: {
  name?: string;
  src?: string | null;
  size?: number;
  className?: string;
}) {
  const label = (name || '').trim();
  const initials = (label || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  // Stable hue from the name — same person, same colour on every screen.
  const seed = label.length ? label.length + label.charCodeAt(0) : 0;
  const hue = HUES[seed % HUES.length];
  const dim = { width: size, height: size };

  if (src) {
    return (
      <img
        src={src}
        alt={label || 'Avatar'}
        style={dim}
        className={cn('rounded-xl object-cover shrink-0 bg-zinc-800', className)}
      />
    );
  }

  return (
    <div
      style={dim}
      className={cn(
        'rounded-xl bg-gradient-to-br flex items-center justify-center text-white font-bold shrink-0',
        hue,
        className,
      )}
    >
      <span style={{ fontSize: Math.max(10, Math.round(size * 0.32)) }}>{initials || '?'}</span>
    </div>
  );
}

export default Avatar;
