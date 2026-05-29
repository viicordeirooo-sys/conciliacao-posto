# Validação de Fórmulas de Dinheiro — Conciliação Posto

(data: 29/05/2026)

## Resumo

Auditoria analítica das 3 fórmulas de dinheiro do sistema (cálculo de taxa/líquido,
data de liquidação D+N e conciliação esperado×real). **Todas corretas.** As mudanças
aplicadas hoje (commit `fcc2b4f`) foram **robustez / defense-in-depth**, não correção
de bug — nenhum bug alcançável foi encontrado nas fórmulas em si.

O sistema tem exatamente 3 fórmulas de dinheiro. As agregações de período
(`renderConciliacao`, `renderResumo`) são apenas `reduce`s sobre as saídas dessas
funções — sem fórmula nova, exceto a taxa efetiva (`taxaEf = totalMDR/totalBruto`,
já com guarda de divisão por zero). **Não existe cálculo de antecipação de recebíveis.**

---

## Funções auditadas

### 1. `getMDR` / `enrichSale` — taxa (MDR) e valor líquido

- **Fórmula**: `custoMDR = round2(bruto × taxa%)` e `liquido = bruto − custoMDR`, onde a
  taxa vem de `STATE.mdr[bandeira][modality]`. Caminho alternativo: se a venda tem
  `liquidoReal` (extraído do PDF), usa o valor real do extrato e deriva a taxa.
- **Veredito**: **Correta.** Risco baixo.
- **Achados**:
  - Taxa ausente para um par bandeira×modalidade vira **0% silencioso** (`?? 0` em
    `getMDR`) — indistinguível de um 0% legítimo (Pix, Voucher). Era o ponto levantado
    no P6.
  - `enrichSale` não valida `amount` internamente — um `NaN` propagaria para todos os
    totais. **Porém**: as 4 portas de entrada de `STATE.sales` (snapshot/load via
    `sanitizeRemoteList`+`normSale`; import JSON via `normSale`; entrada manual via
    checagem inline em `addSale`; import PDF via `mapTipo`+filtro de `vals`) **todas**
    garantem `amount` finito > 0 e bandeira/modalidade na whitelist antes do cálculo.
    Logo o NaN não é alcançável pelo fluxo atual.
- **Status**: Fórmula sem alteração. A fragilidade do NaN/0% é robustez defensiva, não
  bug alcançável. O clamp de MDR aplicado hoje (`clampTaxaMdr`) fecha a porta de NaN
  pela config, que era a única forma de injetar taxa inválida.

### 2. `calcDeposit` / `addBusinessDays` / `addCalendarDays` — data de liquidação D+N

- **Fórmula**: `calcDeposit(data, modalidade)` lê `liquidation[modalidade]` (quantos dias)
  e `corridos[modalidade]` (booleano). Se corrido → soma N dias de calendário; se não →
  soma N dias úteis (pula sábado, domingo e feriados de `STATE.config.holidays`).
  Débito/Voucher = D+1 útil; Crédito = D+30 corrido; Pix = D+0.
- **Veredito**: **Correta.** Risco baixo no código; risco **operacional** médio (depende
  da lista de feriados estar atualizada e do comportamento real da adquirente).
- **Achados**:
  - **Feriado não cadastrado** é contado como dia útil → D+1 do débito/voucher cai 1 dia
    adiantado. A lista ia só até 2026 (corrigido hoje para 2027).
  - **Crédito é D+30 corrido**: cai exatamente 30 dias depois, mesmo em fim de
    semana/feriado. Se a adquirente empurra para o próximo dia útil, gera divergência
    sistemática. **Precisa conferência contra extrato real.**
  - Âncora em `T12:00:00` antes de manipular datas evita o bug clássico de timezone
    (UTC recuar a data). Correto para o fuso do Brasil.
  - Guardas: `n===0` retorna a data intacta (protege Pix); `liquidation[mod] ?? 1` e
    `corridos[mod] ?? false` cobrem config parcial.
  - `days` NaN (alcançável só editando a config): caminho útil retorna a data crua sem
    avançar; caminho corrido lançaria Invalid Date. Comportamentos divergentes.
- **Status**: Feriados 2027 adicionados hoje. Clamp `clampDiasLiq` (inteiro [0,90],
  fallback = `m.d` da modalidade) fecha a porta do NaN/negativo e impede que apagar o
  campo do crédito transforme D+30 em D+1 silenciosamente. Conferência do D+30 em dia
  não-útil fica como cenário de teste com dados reais.

### 3. `getReconciliation` — conciliação esperado × real

- **Fórmula**: agrupa o líquido esperado por `expectedDate`, soma os créditos do banco por
  data, e compara. `|real − esperado| ≤ tolerance` → **conciliado**; senão → **divergência**.
  Sem crédito e data passada → **atrasado** (≥2 dias) ou **em_aberto** (0–1 dia); data futura
  → **a_vencer**; crédito em data sem venda → **sem_venda**.
- **Veredito**: **Correta.** Risco baixo no código; atenção ao match por data exata.
- **Achados**:
  - **Match por data exata** (string ISO). Qualquer dessincronização de 1 dia (feriado
    faltando, ou adquirente pagando em dia diferente do calculado) parte em **duas linhas
    falsas**: um `atrasado`/`em_aberto` fantasma + um `sem_venda`. É a falha mais provável
    no dia-a-dia.
  - **Tolerância é por grupo/data** (default R$ 0,05), não por venda — absorve só o
    arredondamento agregado do dia.
  - `tolerance` NaN (alcançável via config): `Math.abs(diff) <= NaN` é sempre falso →
    **toda data com crédito viraria divergência**. Não havia rede no `getReconciliation`
    (diferente de `days`, que tem o `?? 1` do `calcDeposit`).
  - Antecipação não é modelada: um depósito antecipado aparece como `sem_venda` na data
    real + `atrasado` na data D+N.
- **Status**: Fórmula sem alteração. Clamp `clampTolerancia` ([0,100], default 0,05) fecha
  a porta do NaN em tolerância pela config; `sanitizeConfig` no load fecha a porta remota
  (um `tolerance:NaN` já salvo no Firestore seria saneado na leitura). Antecipação e match
  exato ficam como melhoria/teste.

---

## Melhorias aplicadas hoje (commit `fcc2b4f`)

- **Feriados 2027 (ANBIMA)** adicionados em `DEFAULT_HOLIDAYS` (13 datas). Sem isso,
  débito/voucher D+1 útil perto de feriado em 2027 erraria a data de depósito em 1 dia.
- **3 clamps de config** — `clampTolerancia` ([0,100], default 0,05), `clampDiasLiq`
  (inteiro [0,90], fallback = dia default da modalidade), `clampTaxaMdr` ([0,20], default 0).
  Saneiam NaN/negativo/absurdo nos 3 inputs de dinheiro da aba Config.
- **`sanitizeConfig` / `sanitizeMdr`** aplicados nas **3 portas** (input, remoto via
  `loadFromFirebase`+`onSnapshot`, e `importJSON`). Rodam **depois** do merge
  `{...DEFAULT_*, ...d.*}` e **retornam objeto novo** — sem mutar os `DEFAULT_*`
  compartilhados por referência (bug sutil evitado).

---

## Melhorias pendentes (médio prazo, não-bug)

- **Modelar antecipação na conciliação.** Hoje, se a adquirente paga fora do D+N
  (antecipação), o crédito gera uma linha falsa (`sem_venda` na data real + `atrasado` na
  data D+N). Avaliar match por proximidade ou flag de antecipação quando houver esse
  cenário em produção.
- **Atualizar `DEFAULT_HOLIDAYS` antes de 2028.** A lista vai até 2027; a partir de
  jan/2028 feriados não cadastrados voltam a ser contados como dia útil no D+1.
- (Opcional) **Sanear `postoName` e `corridos` no load** — hoje só `tolerance`,
  `liquidation` e `mdr` passam pelo saneamento defense-in-depth.

---

## Cenários de teste para validar com dados reais

Edge cases que valem verificação manual quando houver volume real de vendas/extrato:

| # | Cenário | Resultado esperado |
|---|---------|--------------------|
| 1 | **Crédito D+30 corrido caindo em fim de semana/feriado.** Lançar venda de crédito cuja data +30 corridos caia num sábado/domingo/feriado. | Conferir contra o extrato real **se a PagBank antecipa para o dia útil anterior ou empurra para o próximo**. Se a adquirente ajusta e o sistema não, surge `divergencia`/`sem_venda` sistemática — pode justificar mudar crédito para D+30 útil ou modelar o ajuste. |
| 2 | **Dia movimentado com muitas vendas pequenas.** Lançar dezenas de vendas no mesmo dia/modalidade e comparar o líquido esperado agregado com o crédito único do banco. | A tolerância de R$ 0,05 (por grupo) deve absorver o resíduo de arredondamento da adquirente. Se aparecer `divergencia` por poucos centavos, reavaliar a tolerância (sem afrouxar a ponto de esconder divergência real). |
| 3 | **Feriado próximo a um D+1 de débito/voucher.** Venda de débito na véspera de feriado. | A data esperada deve **pular** o feriado (e o fim de semana). Conferir que o crédito do banco bate com a data calculada — valida que a lista de feriados 2027 está completa. |
| 4 | **Depósito antecipado pela adquirente.** Crédito caindo no extrato antes da data D+N esperada. | Hoje vira `sem_venda` (data real) + `atrasado`/`em_aberto` (data D+N). Documenta o comportamento atual e mede a frequência — insumo para a melhoria de antecipação. |
| 5 | **Crédito do banco em data sem venda prevista.** Depósito numa data sem grupo de vendas. | Deve aparecer como linha `sem_venda` com o valor integral, sem sumir do total. |
| 6 | **Bandeira/modalidade com taxa 0% legítima vs. não cadastrada.** Venda em Pix/Voucher (0% real) e venda numa bandeira sem taxa salva. | Ambas dão `custoMDR = 0`. Confirmar que o 0% é intencional em cada caso — o sistema não distingue "0% legítimo" de "taxa esquecida". |
| 7 | **Tolerância/dias/MDR com valor inválido na config.** Apagar o campo ou digitar valor absurdo nos inputs da aba Config. | Os clamps devem aplicar o default seguro (tolerância 0,05; dias = default da modalidade; MDR 0) — nenhuma data deve virar `divergencia` em massa nem `calcDeposit` quebrar. |
