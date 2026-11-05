// apps/web/src/app/(player)/provably-fair/page.tsx — complete verifier UI
// (v2 spec + docs/19 §7 + packages/game-core verify fn + docs/18 mono role)
'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { http } from '../../../lib/api';
import { useAuthStore } from '../../../stores';
import { generateClientSeed } from '../../../lib/app';
import { Skeleton } from '../../../components/ui';

interface ActiveSeed {
  serverSeedHash: string;
  clientSeed: string;
  nonce: number;
  roundsUntilRotation: number;
}
interface Verification {
  algorithm: string;
  hashMatches: boolean;
  rawMatches: boolean;
  mappedMatches: boolean;
  payoutMatches: boolean;
  valid: boolean;
  computedHash: string;
  computedRaw: number;
  /** Operator controls in force when the round was decided (disclosure). */
  forceUsed?: 'NONE' | 'FORCE_WIN' | 'FORCE_LOSE';
  difficulty?: 'easy' | 'normal' | 'hard' | 'impossible';
}

export default function ProvablyFairPage() {
  const user = useAuthStore((s) => s.user);
  const { data: seed, isLoading } = useQuery({
    queryKey: ['active-seed'],
    queryFn: () => http.get<ActiveSeed>('/provably-fair/active-seed'),
    enabled: !!user, // D-063: endpoint requires auth — don't fire for guests
  });
  const [roundId, setRoundId] = useState('');
  const [verified, setVerified] = useState<Verification | null>(null);
  const [verifying, setVerifying] = useState(false);

  const rotateSeed = async () => {
    await http.post('/provably-fair/rotate-seed');
    window.location.reload();
  };
  const changeClientSeed = async () => {
    await http.post('/provably-fair/change-client-seed', {
      newClientSeed: generateClientSeed(),
    });
    window.location.reload();
  };

  const verifyRound = async () => {
    setVerifying(true);
    try {
      const result = await http.post<Verification>('/provably-fair/verify', {
        roundId,
      });
      setVerified(result);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="min-h-screen bg-layer-floor px-4 py-6 max-w-md mx-auto">
      <h1 className="t-title text-primary mb-1">Provably Fair</h1>
      <p className="t-body text-secondary mb-6">
        Every round is verifiable. The server commits to a seed hash before you bet;
        after rotation the seed is revealed and you can verify any round.
      </p>

      {/* ACTIVE SEED */}
      <section className="rounded-xl bg-layer-surface border border-white/8 p-4 mb-6">
        <h2 className="t-label-lg text-primary mb-3">Active Seed</h2>
        {isLoading ? (
          <Skeleton className="h-24" />
        ) : (
          seed && (
            <dl className="space-y-3">
              <div>
                <dt className="t-label-sm text-secondary mb-1">
                  Server seed hash (committed)
                </dt>
                <dd className="t-mono text-gold break-all">{seed.serverSeedHash}</dd>
              </div>
              <div className="flex justify-between">
                <div>
                  <dt className="t-label-sm text-secondary mb-1">Client seed</dt>
                  <dd className="t-mono text-primary break-all">{seed.clientSeed}</dd>
                </div>
                <div className="text-right">
                  <dt className="t-label-sm text-secondary mb-1">Nonce</dt>
                  <dd className="t-num-md text-primary">{seed.nonce}</dd>
                </div>
              </div>
              <p className="t-label-sm text-muted">
                Rotates automatically in {seed.roundsUntilRotation} rounds
              </p>
              <div className="flex gap-2 pt-2">
                <button
                  className="btn-outline-gold h-10 px-4 rounded-lg"
                  onClick={rotateSeed}
                >
                  Rotate Seed
                </button>
                <button
                  className="btn-ghost h-10 px-4 rounded-lg"
                  onClick={changeClientSeed}
                >
                  Change Client Seed
                </button>
              </div>
            </dl>
          )
        )}
      </section>

      {/* VERIFY A ROUND */}
      <section className="rounded-xl bg-layer-surface border border-white/8 p-4">
        <h2 className="t-label-lg text-primary mb-3">Verify a Round</h2>
        <div className="flex gap-2 mb-4">
          <input
            value={roundId}
            onChange={(e) => setRoundId(e.target.value)}
            placeholder="Round ID"
            className="flex-1 h-12 px-3 rounded-lg bg-layer-elevated border border-white/10 t-num-md text-primary focus:border-gold/40 outline-none"
          />
          <button
            disabled={!roundId || verifying}
            onClick={verifyRound}
            className="btn-primary h-12 px-5 rounded-lg"
          >
            {verifying ? '…' : 'Verify'}
          </button>
        </div>

        {verified && (
          <div
            className={`rounded-lg p-4 border ${verified.valid ? 'border-green/40 bg-green/10' : 'border-red/40 bg-red/10'}`}
          >
            <p
              className={`t-label-lg mb-2 ${verified.valid ? 'text-green' : 'text-red'}`}
            >
              {verified.valid
                ? '✓ Round verified — math checks out'
                : '✗ Verification failed'}
            </p>
            <dl className="space-y-1.5">
              <div className="flex justify-between">
                <dt className="t-label-sm text-secondary">Algorithm</dt>
                <dd className="t-mono">{verified.algorithm}</dd>
              </div>
              {(verified.forceUsed && verified.forceUsed !== 'NONE') ||
              (verified.difficulty && verified.difficulty !== 'normal') ? (
                <div className="rounded-md border border-gold/30 bg-gold/10 px-3 py-2 mb-1">
                  <p className="t-label-sm text-gold">
                    ⚠ Operator controls were active for this round:
                    {verified.forceUsed && verified.forceUsed !== 'NONE' ? (
                      <>
                        {' '}
                        outcome{' '}
                        <b>
                          {verified.forceUsed === 'FORCE_WIN'
                            ? 'forced to WIN'
                            : 'forced to LOSE'}
                        </b>
                      </>
                    ) : null}
                    {verified.difficulty && verified.difficulty !== 'normal' ? (
                      <>
                        {' '}
                        difficulty <b>{verified.difficulty.toUpperCase()}</b> (win
                        chance{' '}
                        {verified.difficulty === 'easy'
                          ? 'raised ×1.5'
                          : verified.difficulty === 'hard'
                            ? 'halved'
                            : 'reduced ×0.1'}
                        )
                      </>
                    ) : null}
                    . The replay below still matches exactly what the game showed you.
                  </p>
                </div>
              ) : null}
              <div className="flex justify-between">
                <dt className="t-label-sm text-secondary">Committed hash matches</dt>
                <dd className="t-mono">{verified.hashMatches ? '✓' : '✗'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="t-label-sm text-secondary">Raw outcome matches</dt>
                <dd className="t-mono">{verified.rawMatches ? '✓' : '✗'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="t-label-sm text-secondary">
                  Mapped game result matches
                </dt>
                <dd className="t-mono">{verified.mappedMatches ? '✓' : '✗'}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="t-label-sm text-secondary">Payout arithmetic matches</dt>
                <dd className="t-mono">{verified.payoutMatches ? '✓' : '✗'}</dd>
              </div>
              <div>
                <dt className="t-label-sm text-secondary mb-1">Computed hash</dt>
                <dd className="t-mono text-white/70 break-all">
                  {verified.computedHash}
                </dd>
              </div>
              <div>
                <dt className="t-label-sm text-secondary mb-1">Computed raw outcome</dt>
                <dd className="t-mono text-white/70">
                  {verified.computedRaw.toFixed(16)}
                </dd>
              </div>
            </dl>
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-white/5">
          <h3 className="t-label-md text-secondary mb-2">How it works</h3>
          <ol className="t-body text-secondary space-y-1.5 text-sm list-decimal pl-4">
            <li>
              The server generates a secret seed and shows you only its SHA-256 hash.
            </li>
            <li>
              Each bet combines server seed + client seed + nonce via HMAC-SHA256 → a
              number 0–1.
            </li>
            <li>
              After rotation, the old seed is revealed — hash it, recompute, compare.
            </li>
            <li>
              The result number is real; the house edge lives in the public payout
              tables.
            </li>
          </ol>
        </div>
      </section>
    </div>
  );
}
