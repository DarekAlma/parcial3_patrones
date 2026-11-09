import { useEffect, useMemo, useState } from 'react';
import ENVIRONMENT from './graphql/Environment.graphql?raw';
import FLAGS from './graphql/FeatureFlags.graphql?raw';
import STATIONS from './graphql/Stations.graphql?raw';
import TELEMETRY from './graphql/Telemetry.graphql?raw';
import TRANSACTIONS from './graphql/Transactions.graphql?raw';
import WALLETS from './graphql/Wallets.graphql?raw';
import { Canopy } from './components/Canopy';
import { Dispenser } from './components/Dispenser';
import { ServiceCabinet } from './components/ServiceCabinet';
import { StationRail } from './components/StationRail';
import { Ticket } from './components/Ticket';
import { TicketRoll } from './components/TicketRoll';
import { useAppConfig } from './lib/config';
import { usePoll } from './lib/graphql';
import type { ChargeTransaction, EnvironmentInfo, FeatureFlag, Station, TelemetryPoint, Wallet } from './lib/types';

export function App() {
  const config = useAppConfig();
  const env = usePoll<{ environment: EnvironmentInfo }>(ENVIRONMENT, undefined, 15000);
  const stations = usePoll<{ stations: Station[] }>(STATIONS, undefined, 3000);
  const wallets = usePoll<{ wallets: Wallet[] }>(WALLETS, undefined, 5000);
  const flags = usePoll<{ featureFlags: FeatureFlag[] }>(FLAGS, undefined, 4000);
  const history = usePoll<{ transactions: ChargeTransaction[] }>(TRANSACTIONS, { limit: 30 }, 5000, true, 'Transactions');

  const [stationId, setStationId] = useState<string | null>(null);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [fresh, setFresh] = useState<ChargeTransaction | null>(null);
  const [printing, setPrinting] = useState(false);

  const stationList = stations.data?.stations ?? [];
  useEffect(() => {
    if (!stationId && stationList[0]) setStationId(stationList[0].id);
  }, [stationList, stationId]);
  const station = stationList.find((s) => s.id === stationId) ?? null;

  const telemetry = usePoll<{ telemetry: TelemetryPoint[] }>(TELEMETRY, { stationId: stationId ?? '' }, 2000, !!stationId);

  const flagList = flags.data?.featureFlags ?? [];
  const flagOn = (name: string) => flagList.some((f) => f.name === name && f.enabled);
  const historyList = history.data?.transactions ?? [];

  const ticket = useMemo(() => {
    if (ticketId) return historyList.find((t) => t.sagaId === ticketId) ?? (fresh?.sagaId === ticketId ? fresh : null);
    return fresh ?? historyList[0] ?? null;
  }, [ticketId, historyList, fresh]);

  function onTicket(tx: ChargeTransaction) {
    setFresh(tx);
    setTicketId(tx.sagaId);
    setPrinting(true);
    window.setTimeout(() => setPrinting(false), 1600);
  }

  const live = !stations.error && !!stations.lastOk;
  const environment = env.data?.environment ?? null;

  return (
    <div className={`app app-${environment?.environment ?? 'none'}`}>
      <Canopy env={environment} live={live} lastOk={stations.lastOk} />

      <main className="forecourt">
        <div className="lane">
          <StationRail stations={stationList} selected={stationId} onSelect={setStationId} />
          {station ? (
            <Dispenser
              station={station}
              telemetry={telemetry.data?.telemetry ?? []}
              wallets={wallets.data?.wallets ?? []}
              boostEnabled={flagOn('ENABLE_FAST_CHARGE_BOOST')}
              surgeEnabled={flagOn('ENABLE_DYNAMIC_SURGE_PRICING')}
              onTicket={onTicket}
              onAfterCharge={() => {
                void stations.refresh();
                void wallets.refresh();
                void history.refresh();
              }}
            />
          ) : (
            <div className="dispenser dispenser-empty" role="status">
              {stations.error ? `No se pudo leer el patio: ${stations.error}` : 'Encendiendo surtidores…'}
            </div>
          )}
          <ServiceCabinet
            environment={environment?.environment ?? null}
            adminEnabled={!!environment?.flagAdminEnabled}
            flags={flagList}
            peers={config.peers}
            onChanged={() => void flags.refresh()}
          />
        </div>

        <aside className="printer" aria-label="Impresora de comprobantes">
          <div className="printer-slot" aria-hidden="true" />
          <div className="printer-paper">
            <Ticket tx={ticket} printing={printing} />
          </div>
          <TicketRoll items={historyList} selected={ticket?.sagaId ?? null} onSelect={setTicketId} />
        </aside>
      </main>

      <footer className="site-foot">
        <span>AegisVolt · {environment ? `ambiente ${environment.environment}` : 'sin ambiente'} · GraphQL vía API Gateway</span>
        <span>Datos de demostración (sintéticos): estaciones, flotas y telemetría simulada</span>
      </footer>
    </div>
  );
}
