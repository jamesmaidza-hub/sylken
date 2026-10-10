import type { Ctx } from './app.js'
import { RangeForm } from './cashup.js'
import { formatHref, type Col } from './export.js'
import { money } from './layout.js'

/** A column on screen as well as in the download: show overrides how the cell looks. */
export type ScreenCol<T> = Col<T> & { show?: (r: T) => any }

const cell = <T,>(c: ScreenCol<T>, r: T) => {
  if (c.show) return c.show(r)
  const v = c.v(r)
  if (v === null || v === undefined) return ''
  return c.fmt === 'money' ? money(Number(v)) : c.fmt === 'pct' ? `${Number(v).toFixed(1)}%` : v
}

const numeric = (c: ScreenCol<any>) => !!c.fmt

export interface ReportProps<T> {
  c: Ctx; title: string; intro: string; range?: { from: string; to: string; today: string }; filters?: any; keep?: string
  cols: ScreenCol<T>[]; rows: T[]; foot?: T; summary?: any; href?: (r: T) => string | undefined; hint?: string; before?: any; toolbar?: any; noTable?: boolean
}

/** The page every report shares: title, dates and filters, Excel/CSV/print, then the table. */
export function ReportPage<T>(props: ReportProps<T>) {
  const { c, cols } = props
  return (
    <>
      {props.toolbar}
      <div class="row"><h1>{props.title}</h1><span class="spacer" />
        <a class="btn secondary" href={formatHref(c, 'xlsx')}>Download Excel</a>
        <a class="btn secondary" href={formatHref(c, 'csv')}>Download CSV</a>
        <button class="secondary" onclick="window.print()">Print</button></div>
      <p class="muted">{props.intro}</p>
      {props.range
        ? <RangeForm {...props.range} extra={props.filters} keep={props.keep} />
        : props.filters && <form class="row panel">{props.filters}<button class="secondary">Show</button></form>}
      {props.before}
      <p class="muted">{props.summary ?? `${props.rows.length} rows`}</p>
      {!props.noTable && <>
        <div class="wrap"><table>
          <thead><tr>{cols.map((x) => <th class={numeric(x) ? 'n' : ''}>{x.h}</th>)}</tr></thead>
          <tbody>{props.rows.map((r) => {
            const href = props.href?.(r)
            return <tr data-href={href}>{cols.map((x) => <td class={numeric(x) ? 'n' : ''}>{cell(x, r)}</td>)}</tr>
          })}</tbody>
          {props.foot && <tfoot><tr>{cols.map((x) => <td class={numeric(x) ? 'n' : ''}><b>{cell(x, props.foot!)}</b></td>)}</tr></tfoot>}
        </table></div>
        {!props.rows.length && <p class="muted">Nothing to show.</p>}
      </>}
      {props.hint && <p class="hint">{props.hint}</p>}
    </>
  )
}

export const file = (name: string, r: { from: string; to: string }) => `${name}-${r.from}-${r.to}`
