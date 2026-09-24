// src/v2/components/ma/MaAddressExplorerV2.jsx
//
// Endereços de uma peça: ranking (4 colunas) + mapa (8 colunas), com filtro
// por cidade na barra da seção. Serve o Tap to Map (exibições) e o widget
// Loja mais próxima (identificações).
//
//   • ranking ordenado pela métrica principal; número do ranking é o mesmo
//     no marcador do mapa e não muda com o filtro;
//   • rua em destaque, "bairro · cidade/UF" embaixo (shared/maAddress.js);
//     colunas que seriam só zeros viram texto curto ("1 rota · 1 pin");
//   • cidade escolhida filtra o ranking e enquadra o mapa; "Ver todos"
//     devolve a visão geral;
//   • no celular o mapa vem antes do ranking.

import { useMemo, useState } from "react";
import { fmt } from "../../../shared/format";
import { addressSubtitle, citiesOf, parseAddress } from "../../../shared/maAddress";
import { cn } from "../../../ui/cn";
import { ChipGroupV2 } from "../ChipGroupV2";
import { MaAddressMapV2 } from "./MaAddressMapV2";
import { CsvButton, MaActionButton, MaCard, MaSection } from "./maUi";

const INITIAL = 10;
const MAX_CITY_CHIPS = 7;

/**
 * items: [{ key, name, address?, lat, lng, primary, rateText, actions?, popupRows }]
 *   name     texto principal (endereço do geocoder ou nome da loja)
 *   address  logradouro, quando `name` é nome de loja (Loja mais próxima)
 */
export function MaAddressExplorerV2({
  title = "Endereços",
  subtitle,
  items = [],
  primaryLabel = "Exibições",
  onCsv,
  footnote,
  mapHeight = 300,
}) {
  const [focus, setFocus] = useState(null);
  const [city, setCity] = useState("all");
  const [open, setOpen] = useState(false);
  const [fitN, setFitN] = useState(0);

  const rows = useMemo(() => {
    const parsed = items.map((it, i) => {
      const fromName = parseAddress(it.name);
      const fromAddr = it.address ? parseAddress(it.address) : null;
      const address = fromName.city ? fromName : fromAddr || fromName;
      const title = fromName.city ? fromName.street : it.name;
      const sub = it.address && !fromName.city
        ? [fromAddr?.street, addressSubtitle(fromAddr)].filter(Boolean).join(" · ")
        : addressSubtitle(fromName);
      return { ...it, idx: i, address, title: title || "Endereço sem nome", sub };
    });
    parsed.sort((a, b) => (b.primary || 0) - (a.primary || 0) || a.idx - b.idx);
    return parsed.map((r, i) => ({ ...r, rank: i + 1 }));
  }, [items]);

  const cities = useMemo(() => citiesOf(rows, (r) => r.primary), [rows]);
  const cityKey = cities.some((c) => c.key === city) ? city : "all";
  const inCity = cityKey === "all" ? rows : rows.filter((r) => `${r.address.city}|${r.address.uf || ""}` === cityKey);
  const visible = open ? inCity : inCity.slice(0, INITIAL);
  const max = Math.max(...rows.map((r) => r.primary || 0), 1);

  const points = useMemo(
    () => rows.map((r) => ({
      key: r.key,
      rank: r.rank,
      name: r.title,
      subtitle: r.sub,
      lat: r.lat,
      lng: r.lng,
      weight: r.primary,
      rows: r.popupRows,
    })),
    [rows],
  );
  const fit = useMemo(
    () => ({ n: fitN, keys: cityKey === "all" ? null : inCity.map((r) => r.key) }),
    // o pedido de enquadramento é disparado só pelo fitN
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fitN],
  );

  if (!rows.length) return null;

  const pickCity = (k) => {
    setCity(k);
    setOpen(false);
    setFocus(null);
    setFitN((n) => n + 1);
  };
  const showAll = () => pickCity("all");
  const pick = (r) => {
    setFocus(r.key);
    if (cityKey !== "all" && `${r.address.city}|${r.address.uf || ""}` !== cityKey) setCity("all");
  };

  const cityLabel = cityKey === "all" ? "Todas as cidades" : cities.find((c) => c.key === cityKey)?.city;
  const chips = cities.length > 1 ? (
    <ChipGroupV2
      label="Filtrar por cidade"
      value={cityKey}
      onChange={pickCity}
      options={[
        { value: "all", label: "Todas" },
        ...cities.slice(0, MAX_CITY_CHIPS).map((c) => ({ value: c.key, label: c.city, count: fmt(c.count) })),
      ]}
    />
  ) : null;

  return (
    <MaSection
      title={title}
      subtitle={subtitle || `${fmt(rows.length)} ${rows.length === 1 ? "endereço" : "endereços"}`}
      tools={chips}
    >
      <div className="grid gap-4 lg:grid-cols-12 items-stretch">
        <MaCard
          className="lg:col-span-4 order-2 lg:order-1"
          title="Ranking"
          subtitle={`${cityLabel} · por ${primaryLabel.toLowerCase()}`}
          actions={onCsv ? <CsvButton onClick={onCsv} /> : null}
          footer={
            <>
              {inCity.length > INITIAL && (
                <button type="button" onClick={() => setOpen((v) => !v)} className="font-semibold text-signature hover:underline underline-offset-4 cursor-pointer">
                  {open ? `Mostrar só os ${INITIAL} primeiros` : `Mostrar os ${fmt(inCity.length)}`}
                </button>
              )}
              {footnote && <span>{footnote}</span>}
            </>
          }
        >
          <div className="grid grid-cols-[minmax(0,1fr)_auto] px-2 pb-2 border-b border-border text-[11px] font-bold uppercase tracking-wider text-fg-subtle">
            <span>Endereço</span>
            <span className="text-signature">{primaryLabel} ↓</span>
          </div>
          <ol className="mt-1 grid gap-0.5" aria-label={`Ranking por ${primaryLabel.toLowerCase()}`}>
            {visible.map((r) => {
              const on = focus === r.key;
              return (
                <li key={r.key}>
                  <button
                    type="button"
                    onClick={() => pick(r)}
                    aria-pressed={on}
                    className={cn(
                      "grid w-full grid-cols-[1.5rem_minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-0.5 rounded-lg px-2 py-2.5 text-left cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signature",
                      on ? "bg-signature-soft" : "hover:bg-surface",
                    )}
                  >
                    <span className="text-[11px] font-bold tabular-nums text-fg-subtle">{r.rank}</span>
                    <span className="truncate text-[13px] font-bold text-fg" title={r.name}>{r.title}</span>
                    <span className="text-right text-[13px] font-bold tabular-nums text-fg">{fmt(r.primary)}</span>
                    <span className="col-start-2 truncate text-xs text-fg-subtle">
                      {[r.sub, r.actions].filter(Boolean).join(" · ") || " "}
                    </span>
                    <span className="text-right text-xs tabular-nums text-fg-subtle whitespace-nowrap">{r.rateText}</span>
                    <span className="col-start-2 col-span-2 mt-1.5 h-1 rounded-full bg-track overflow-hidden" aria-hidden>
                      <span className="block h-full rounded-full bg-signature" style={{ width: `${Math.max(r.primary > 0 ? 1 : 0, (r.primary / max) * 100)}%` }} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </MaCard>

        <MaCard
          className="lg:col-span-8 order-1 lg:order-2"
          bodyClassName="flex flex-col"
          title="Mapa"
          subtitle={`${cityLabel} · ${fmt(inCity.length)} ${inCity.length === 1 ? "endereço" : "endereços"}`}
          actions={<MaActionButton onClick={showAll} aria-label="Ver todos os endereços no mapa">⤢ Ver todos</MaActionButton>}
        >
          <div className="flex-1 flex flex-col lg:min-h-[460px]">
            <MaAddressMapV2
              points={points}
              focusKey={focus}
              onFocus={setFocus}
              fit={fit}
              height={null}
              minHeight={mapHeight}
              className="flex-1"
            />
          </div>
        </MaCard>
      </div>
    </MaSection>
  );
}
