import type { Logger, ServiceClient } from '@aegisvolt/common';
import type { ChargingSession, DispatchRepository, TelemetryPoint } from './repository.js';

/**
 * Simulador del hardware del cargador. Cada tick avanza las sesiones ACTIVE,
 * registra un punto de telemetria y, al llegar a la energia objetivo, cierra
 * la sesion y libera la bahia (station-reservation-service /complete).
 *
 * speedFactor acelera el tiempo para demos (60 => 1 s real = 1 min de carga).
 */
export class ChargingSimulator {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly repo: DispatchRepository,
    private readonly stations: ServiceClient,
    private readonly logger: Logger,
    private readonly intervalMs = 2000,
    private readonly speedFactor = 60,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sessions = await this.repo.listSessions('ACTIVE');
      for (const session of sessions) await this.advance(session);
    } catch (err) {
      this.logger.warn('simulator tick failed', { event: 'simulator_error', error: err as Error });
    } finally {
      this.running = false;
    }
  }

  private async advance(session: ChargingSession): Promise<void> {
    const elapsedH = ((Date.now() - session.lastTickAt) / 3_600_000) * this.speedFactor;
    const progress = session.kwhDelivered / session.kwhTarget;
    // Curva de carga: potencia plena hasta el 80% y luego desciende (taper).
    const powerKw = progress < 0.8 ? session.powerKw * (0.92 + Math.random() * 0.06) : session.powerKw * (1 - progress) * 4;
    const kwhDelivered = Number((session.kwhDelivered + Math.max(powerKw, 1) * elapsedH).toFixed(3));

    const won = await this.repo.advance(session, kwhDelivered, this.intervalMs * 0.75);
    if (!won) return; // otra replica proceso este tick

    const log = this.logger.child({ correlation_id: session.sagaId });
    const point: TelemetryPoint = {
      stationId: session.stationId,
      connectorId: session.connectorId,
      sagaId: session.sagaId,
      timestamp: new Date().toISOString(),
      powerKw: Number(powerKw.toFixed(1)),
      kwhDelivered: Math.min(kwhDelivered, session.kwhTarget),
      voltageV: Math.round(780 + Math.random() * 40),
      currentA: Math.round((powerKw * 1000) / 800),
      temperatureC: Number((28 + progress * 12 + Math.random() * 2).toFixed(1)),
      socPercent: Math.min(100, Math.round(20 + progress * 80)),
    };
    await this.repo.putTelemetry(point);

    if (kwhDelivered >= session.kwhTarget) {
      log.info('charging session completed', { event: 'charging_completed', saga_id: session.sagaId, kwh: session.kwhTarget });
      try {
        await this.stations.call('POST', `/reservations/${session.sagaId}/complete`, {}, { correlationId: session.sagaId });
      } catch (err) {
        log.warn('could not release connector after completion', { event: 'complete_release_failed', error: err as Error });
      }
    }
  }
}
