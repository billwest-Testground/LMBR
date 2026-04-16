/**
 * ConsolidationControls — pre-send mode selector + preview.
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import type { ConsolidationMode } from '@lmbr/types';
import { consolidationAgent, type ConsolidationLineItem } from '@lmbr/agents';

interface ConsolidationControlsProps {
  bidId: string;
  lineItems: ConsolidationLineItem[];
  buildingCount: number;
  phaseNumbers: number[];
  onConfirm: (mode: ConsolidationMode) => void;
}

interface ModeCard {
  mode: ConsolidationMode;
  title: string;
  description: string;
}

const MODES: ModeCard[] = [
  {
    mode: 'structured',
    title: 'Structured',
    description: 'Keep list exactly as extracted. All building breaks preserved.',
  },
  {
    mode: 'consolidated',
    title: 'Consolidated',
    description: 'Aggregate like items across all buildings for best mill pricing.',
  },
  {
    mode: 'phased',
    title: 'Phased',
    description: 'Quote each phase independently. Select which phases to include.',
  },
  {
    mode: 'hybrid',
    title: 'Hybrid',
    description: 'Consolidated for vendors, structured for customer quote.',
  },
];

export function ConsolidationControls({
  bidId,
  lineItems,
  buildingCount,
  phaseNumbers,
  onConfirm,
}: ConsolidationControlsProps) {
  const [selectedMode, setSelectedMode] = useState<ConsolidationMode>(
    buildingCount >= 3 ? 'hybrid' : 'structured',
  );
  const [activePhases, setActivePhases] = useState<number[]>(phaseNumbers);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useMemo(() => {
    if (selectedMode === 'structured') return null;
    try {
      return consolidationAgent({
        lineItems,
        mode: selectedMode === 'phased' ? 'phased' : selectedMode,
        activePhases: selectedMode === 'phased' ? activePhases : undefined,
      });
    } catch {
      return null;
    }
  }, [lineItems, selectedMode, activePhases]);

  const handleConfirm = useCallback(async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bidId,
          mode: selectedMode,
          activePhases: selectedMode === 'phased' ? activePhases : undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? 'Consolidation failed');
      }
      onConfirm(selectedMode);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Consolidation failed');
    } finally {
      setIsSubmitting(false);
    }
  }, [bidId, selectedMode, activePhases, onConfirm]);

  const togglePhase = useCallback((phase: number) => {
    setActivePhases((prev) =>
      prev.includes(phase)
        ? prev.filter((p) => p !== phase)
        : [...prev, phase],
    );
  }, []);

  return (
    <div className="space-y-6">
      {/* Mode selector */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {MODES.map((m) => (
          <button
            key={m.mode}
            onClick={() => setSelectedMode(m.mode)}
            className={`relative rounded border p-4 text-left transition-all duration-150 ${
              selectedMode === m.mode
                ? 'border-accent-primary bg-accent-primary/[0.08]'
                : 'border-border-base bg-bg-surface hover:border-border-strong'
            }`}
          >
            {selectedMode === m.mode && (
              <div className="absolute right-2 top-2 h-5 w-5 rounded-full bg-accent-primary flex items-center justify-center">
                <span className="text-xs text-text-inverse font-bold">&#10003;</span>
              </div>
            )}
            {m.mode === 'hybrid' && buildingCount >= 3 && (
              <span className="absolute left-2 top-2 rounded-full bg-accent-warm px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-inverse">
                Recommended
              </span>
            )}
            <div className="mt-4">
              <h4 className="text-[15px] font-semibold text-text-primary">{m.title}</h4>
              <p className="mt-1 text-[13px] text-text-secondary">{m.description}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Preview panel */}
      {selectedMode !== 'structured' && preview && (
        <div className="rounded border border-border-base bg-bg-subtle p-4">
          <div className="mb-4 text-center">
            <p className="text-lg font-semibold text-text-primary">
              {preview.summary.originalCount} line items{' '}
              <span className="text-accent-primary">&#8594;</span>{' '}
              {preview.summary.consolidatedCount} consolidated items{' '}
              <span className="text-accent-warm">
                ({preview.summary.reductionPercent}% reduction)
              </span>
            </p>
            {selectedMode === 'hybrid' && (
              <p className="mt-1 text-sm text-text-secondary">
                Vendor sends: {preview.summary.consolidatedCount} lines
                &nbsp;&nbsp;|&nbsp;&nbsp;
                Customer sees: {preview.summary.originalCount} lines
              </p>
            )}
          </div>

          {selectedMode === 'phased' && phaseNumbers.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
                Select phases to quote now
              </p>
              {phaseNumbers.map((phase) => (
                <label
                  key={phase}
                  className="flex items-center gap-3 rounded border border-border-base bg-bg-surface p-3 cursor-pointer hover:border-border-strong"
                >
                  <input
                    type="checkbox"
                    checked={activePhases.includes(phase)}
                    onChange={() => togglePhase(phase)}
                    className="h-4 w-4 accent-accent-primary"
                  />
                  <span className="text-sm text-text-primary">Phase {phase}</span>
                  <span className="ml-auto text-xs text-text-tertiary">
                    {lineItems.filter((li) => li.phaseNumber === phase).length} items
                  </span>
                </label>
              ))}
              {preview.deferredPhases.length > 0 && (
                <p className="text-xs text-text-tertiary mt-2">
                  Deferred: Phase {preview.deferredPhases.join(', ')} (quote later)
                </p>
              )}
            </div>
          )}

          {(selectedMode === 'consolidated' || selectedMode === 'hybrid') &&
            preview.consolidatedItems.length > 0 && (
              <div className="mt-3 max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border-base text-[11px] font-medium uppercase tracking-wider text-text-tertiary">
                      <th className="py-2 text-left">Item</th>
                      <th className="py-2 text-right">Qty</th>
                      <th className="py-2 text-right">BF</th>
                      <th className="py-2 text-right">Sources</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.consolidatedItems.slice(0, 20).map((item, i) => (
                      <tr key={i} className="border-b border-border-subtle">
                        <td className="py-2 text-text-secondary">
                          {item.species} {item.dimension} {item.grade || ''} {item.length || ''}
                        </td>
                        <td className="py-2 text-right font-mono text-text-primary">
                          {item.quantity.toLocaleString()} {item.unit}
                        </td>
                        <td className="py-2 text-right font-mono text-text-primary">
                          {item.boardFeet.toLocaleString()}
                        </td>
                        <td className="py-2 text-right text-text-tertiary">
                          {item.sourceLineItemIds.length}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.consolidatedItems.length > 20 && (
                  <p className="mt-2 text-xs text-text-tertiary text-center">
                    + {preview.consolidatedItems.length - 20} more items
                  </p>
                )}
              </div>
            )}
        </div>
      )}

      {error && (
        <div className="rounded border border-semantic-error/40 bg-semantic-error/10 p-3 text-sm text-semantic-error">
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={handleConfirm}
          disabled={isSubmitting || (selectedMode === 'phased' && activePhases.length === 0)}
          className="rounded-sm bg-accent-primary px-4 py-2 text-sm font-medium text-text-inverse hover:bg-accent-secondary active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none transition-all duration-150"
        >
          {isSubmitting ? 'Applying...' : 'Apply & continue to routing'}
        </button>
      </div>
    </div>
  );
}
