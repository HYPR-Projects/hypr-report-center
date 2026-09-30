// src/v2/components/dv/PoweredByDV.jsx
//
// Selo "Powered by DoubleVerify" da aba Quality. A logo tem duas versões por
// tema: a original (texto azul-marinho) só lê em fundo claro, então o tema
// escuro usa uma cópia com o texto clareado — o símbolo colorido fica igual
// nos dois, que é o que identifica a marca.

import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../../ui/cn";
import horizontalLight from "../../../assets/dv/dv-logo-horizontal-light.png";
import horizontalDark from "../../../assets/dv/dv-logo-horizontal-dark.png";

export function PoweredByDV({ className }) {
  const [theme] = useTheme();
  return (
    <span className={cn("inline-flex items-center gap-2.5 select-none", className)}>
      <span className="text-[9.5px] font-semibold uppercase tracking-[0.16em] text-fg-subtle leading-none">
        Powered by
      </span>
      <img
        src={theme === "light" ? horizontalLight : horizontalDark}
        alt="DoubleVerify"
        className="h-[22px] w-auto"
        draggable={false}
      />
    </span>
  );
}
