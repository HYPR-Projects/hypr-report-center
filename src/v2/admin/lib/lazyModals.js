// src/v2/admin/lib/lazyModals.js
//
// Modais pesados do admin carregados sob demanda. O SurveyModal sozinho tem
// ~113 kB de JS e o MergeModal ~25 kB; os dois só abrem por ação explícita,
// então não precisam estar no chunk que pinta o menu / o drilldown do
// cliente. Definidos num módulo único pra que as duas páginas compartilhem a
// MESMA promise de import (preload feito numa serve pra outra).
//
// As páginas chamam `preloadWhenIdle(SurveyModal, MergeModal)` no mount:
// o JS chega em background e o clique não espera download.

import { lazyWithPreload } from "../../../shared/lazyWithPreload";

export const SurveyModal = lazyWithPreload(() => import("../../../components/modals/SurveyModal"));
export const MergeModal = lazyWithPreload(() => import("../../../components/modals/MergeModal"));
