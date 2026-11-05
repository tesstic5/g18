// apps/web/src/lib/toast.ts — react-hot-toast wrapper styled to the design system (v7 §10)
import toast, { Toaster } from 'react-hot-toast';

const base = {
  background: 'var(--bg-elevated)',
  color: '#ffffff',
  border: '1px solid rgba(255,255,255,0.10)',
  borderRadius: '8px',
  fontSize: '14px',
  fontFamily: 'Inter, sans-serif',
  fontWeight: 500 as const,
  padding: '12px 16px',
  maxWidth: '320px',
  boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
};

export { Toaster };

export const notify = {
  success: (message: string) =>
    toast.success(message, {
      icon: '✅',
      style: { ...base, borderColor: 'rgba(0,217,126,0.25)' },
      duration: 3000,
    }),
  error: (message: string) =>
    toast.error(message, {
      icon: '❌',
      style: { ...base, borderColor: 'rgba(255,59,92,0.25)' },
      duration: 5000,
    }),
  info: (message: string) => toast(message, { icon: 'ℹ️', duration: 3000 }),
  win: (amount: string) =>
    toast.success(`+${amount}`, {
      icon: '🏆',
      style: {
        ...base,
        borderColor: 'rgba(245,200,66,0.40)',
        color: '#f5c842',
        fontWeight: 700,
        fontSize: '18px',
      },
      duration: 2000,
    }),
  loading: (message: string) => toast.loading(message, { style: base }),
  dismiss: (id: string) => toast.dismiss(id),
};
