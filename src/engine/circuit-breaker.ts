import type { CircuitState } from './types.js';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  cooldownMs: number;
  maxCooldownMs: number;
}

export type StateChangeCallback = (
  providerId: string,
  from: CircuitState,
  to: CircuitState,
) => void;

interface ProviderCircuit {
  state: CircuitState;
  consecutiveFailures: number;
  lastFailureTime: number;
  currentCooldownMs: number;
  probeInFlight: boolean;
}

export class CircuitBreaker {
  private readonly config: CircuitBreakerConfig;
  private readonly circuits = new Map<string, ProviderCircuit>();
  private readonly listeners: StateChangeCallback[] = [];

  constructor(config: CircuitBreakerConfig) {
    this.config = config;
  }

  getState(providerId: string): CircuitState {
    const circuit = this.circuits.get(providerId);
    return circuit ? circuit.state : 'closed';
  }

  tryProbe(providerId: string): boolean {
    const circuit = this.getOrCreate(providerId);

    switch (circuit.state) {
      case 'closed':
        return true;

      case 'open': {
        const elapsed = Date.now() - circuit.lastFailureTime;
        if (elapsed < circuit.currentCooldownMs) {
          return false;
        }
        // Cooldown expired -- transition to half-open and grant this one caller
        this.transition(circuit, providerId, 'half-open');
        circuit.probeInFlight = true;
        return true;
      }

      case 'half-open': {
        if (circuit.probeInFlight) {
          return false;
        }
        // No probe in flight -- grant exactly one caller
        circuit.probeInFlight = true;
        return true;
      }
    }
  }

  recordSuccess(providerId: string): void {
    const circuit = this.getOrCreate(providerId);
    const previousState = circuit.state;

    circuit.consecutiveFailures = 0;
    circuit.currentCooldownMs = this.config.cooldownMs;
    circuit.probeInFlight = false;

    if (previousState !== 'closed') {
      this.transition(circuit, providerId, 'closed');
    }
  }

  recordFailure(providerId: string): void {
    const circuit = this.getOrCreate(providerId);

    circuit.consecutiveFailures++;
    circuit.lastFailureTime = Date.now();

    if (circuit.state === 'half-open') {
      // Failed probe -- re-open with extended cooldown
      circuit.currentCooldownMs = Math.min(
        circuit.currentCooldownMs * 2,
        this.config.maxCooldownMs,
      );
      circuit.probeInFlight = false;
      this.transition(circuit, providerId, 'open');
      return;
    }

    // In closed state -- check if we should trip open
    if (
      circuit.state === 'closed' &&
      circuit.consecutiveFailures >= this.config.failureThreshold
    ) {
      circuit.currentCooldownMs = this.config.cooldownMs;
      this.transition(circuit, providerId, 'open');
    }
  }

  onStateChange(callback: StateChangeCallback): void {
    this.listeners.push(callback);
  }

  private getOrCreate(providerId: string): ProviderCircuit {
    let circuit = this.circuits.get(providerId);
    if (!circuit) {
      circuit = {
        state: 'closed',
        consecutiveFailures: 0,
        lastFailureTime: 0,
        currentCooldownMs: this.config.cooldownMs,
        probeInFlight: false,
      };
      this.circuits.set(providerId, circuit);
    }
    return circuit;
  }

  private transition(
    circuit: ProviderCircuit,
    providerId: string,
    to: CircuitState,
  ): void {
    const from = circuit.state;
    circuit.state = to;
    for (const listener of this.listeners) {
      listener(providerId, from, to);
    }
  }
}
