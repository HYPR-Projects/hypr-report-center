// src/v2/dashboards/ClientDashboardV2.jsx
//
// STUB do ClientDashboardV2 — agora usando os primitives.
//
// Objetivo do stub: validar que Button + Card + Badge funcionam end-to-end
// com classes Tailwind + tokens HYPR antes de escalar pra Visão Geral
// real (próxima PR).
//
// Substituição na Fase 2: este arquivo passa a renderizar o V2 real
// (tabs + dados + filtros). O contrato com App.jsx (props: token,
// isAdmin) permanece o mesmo.

import "../v2.css";          // entry CSS (Tailwind + theme + reset)
import "../../ui/typography"; // carrega Urbanist (efeito colateral)
import { setReportVersion } from "../../shared/version";
import { Card, CardHeader, CardBody, CardFooter } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";

export default function ClientDashboardV2({ token, isAdmin /*, adminJwt */ }) {
  const goLegacy = () => {
    setReportVersion("legacy");
    // Remove ?v= da URL pra que o reload não force V2 de novo.
    const url = new URL(window.location.href);
    url.searchParams.delete("v");
    window.location.replace(url.toString());
  };

  return (
    <div className="font-sans min-h-screen bg-canvas text-fg flex items-center justify-center p-6">
      <Card className="w-full max-w-md text-center">
        <CardHeader>
          <div className="flex justify-center mb-4">
            <Badge variant="signature" size="md">
              Preview · V2
            </Badge>
          </div>
          <h1 className="text-3xl font-bold leading-tight text-fg">
            Em construção
          </h1>
          <p className="text-base leading-relaxed text-fg-muted mt-3">
            Esta é a próxima versão do dashboard de reports da HYPR. O
            conteúdo será construído nas próximas semanas. Por enquanto,
            a versão estável continua disponível.
          </p>
        </CardHeader>

        <CardBody>
          <Button variant="primary" size="lg" onClick={goLegacy} fullWidth>
            Voltar à versão atual
          </Button>
        </CardBody>

        <CardFooter className="justify-start">
          <div className="font-mono text-xs text-fg-subtle break-all text-left w-full">
            <div>token: {token || "—"}</div>
            <div>modo: {isAdmin ? "admin" : "cliente"}</div>
          </div>
        </CardFooter>
      </Card>
    </div>
  );
}
