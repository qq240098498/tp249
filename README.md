# 冷链温控与批次放行台

冷库与冷藏车的温控值班台：录冷库与探头、登批次、盯温度记录、算超限与断链、判放行还是拒收。

## 运行

```
npm install
npm start
```

默认端口 5249（`PORT` 可以覆盖），数据存在 `data/db.json`，页面在 `/`。

## 页面

- **概览**：冷库与运行中数量、探头数量与已过校准期的探头数、批次总数与各状态条数、温度记录条数与人工记录数、放行与拒收条数、当前满足放行条件的批次数与被挡下的批次数、没有任何温度记录的批次数、最高与平均 MKT、按冷库一行给出探头与批次数。
- **冷库与探头**：冷库台账（编码、名称、类型、位置、库位、状态）与探头台账（编号、所属冷库、位置、状态、校准有效期、记录条数），都带增改删。
- **批次**：批次清单（批次号、品名、规格、件数、所在冷库、入库时刻、状态、温度记录条数、最长超限、累计超限、MKT、断链数、放行情况），行内展开逐条温度记录、超限段、断链缺口、放行判定四项与放行单，并提供「放行」「拒收」入口。
- **温度记录**：记录清单（批次、探头、时刻、温度、来源、登记人、是否超限），支持按批次与探头筛选、单条新增与删除。
- **放行台账**：放行与拒收记录（批次、决定、时刻、经办人、当时的 MKT、最长超限、累计超限、断链数与依据），行内展开可对一条有效放行记录**出具放行单**、**登记对外发出**、**登记对方回执**、**撤销（必须写依据）后重新出具**，并显示单据与台账的**逐字段对账**结果；左侧可按放行单状态、回执状态、是否对不上筛选。

## 口径（页面上的说明与数字都要与本段一致）

1. **温度带**：默认 2 到 8 摄氏度（可在设置里改），低于下限或高于上限都算超限。
2. **超限段**：按时刻顺序逐条判，连续超限的时段算一段，**中间只要有记录回到范围内就断开**；每段的时长按该段相邻记录的实际时刻差累加。
3. **累计超限**：一个批次从入库到当前，所有超限段的时长之和；**跨月不重置**，按批次周期累计。
4. **断链**：相邻两条记录的时刻差超过 `chainGapMinutes`（默认 15 分钟）算一处断链，缺口时长按实际时刻差算。
5. **MKT（平均动力学温度）**：按动力学公式算，写成 `MKT = −Ea / (R × ln((Σ e^(−Ea/(R·T)) ) / n)) − 273.15`（活化能 Ea 取 83144 J/mol、气体常数 R 取 8.314，T 用开尔文，n 为参与计算的记录条数）；**不是把温度取平均**。
6. **放行判定四条**：单次连续超限不超过 `allowExcursionMinutes`（默认 30 分钟）、累计超限不超过 `allowTotalExcursionMinutes`（默认 120 分钟）、全程没有断链、**参与判定的探头都在校准有效期内**。四条同时满足才算满足放行条件；**没有任何温度记录的批次不能放行**。
7. **同一探头同一时刻既有自动记录又有手工更正记录时，以手工记录为准**；停用探头名下的记录不参与判定。
8. **停用与检修中的冷库**：其批次仍然照常记录与判定，但在清单里要标出来。
9. **放行单**：按一条有效放行记录出具，单据编号按 `FXD-年份-序号`（如 `FXD-2026-0001`）生成，编号不可重复、撤销或作废都不复用；一张单只对应一条有效放行记录，同一批次只允许一张有效单据，重复出具会被拦下并提示已出过的单号。出具时把批次信息、当时的 MKT、最长/累计超限、断链数与判定四条**原样快照**到单据上；单据登记发出后内容锁定，要改必须先**撤销（必须填撤销依据与经办人）再按同一记录出新单**，旧单保留并与新单互相标注替代关系。发出可登记发出时刻、接收方、发出经办人、方式，回执可登记回执状态（已签收/拒收/其他）、回执时刻、签收人；回执时刻不能早于发出时刻。单据快照与台账同一条记录（及所属批次）可**逐字段对账**，任一字段对不上都会点出字段名与两边的值，台账可只筛“对不上”的记录。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /api/health、/api/summary、/api/settings | 健康检查、概览、设置（PATCH 可改） |
| GET / POST | /api/rooms | 冷库清单（支持 status、type、keyword）/ 新增 |
| GET / PATCH / DELETE | /api/rooms/:id | 详情（含探头与批次）/ 修改 / 删除 |
| GET / POST | /api/probes | 探头清单（支持 roomId、status）/ 新增 |
| PATCH / DELETE | /api/probes/:id | 修改 / 删除 |
| GET / POST | /api/batches | 批次清单（支持 roomId、status、product）/ 新增 |
| GET / PATCH / DELETE | /api/batches/:id | 详情（含记录、超限段、断链、放行单）/ 修改 / 删除 |
| GET | /api/batches/:id/release-check | 这个批次的放行判定 |
| POST | /api/batches/:id/decision | 放行或者拒收，body `{decision, decider, decidedAt, basis, remark}` |
| GET / POST | /api/records | 温度记录（支持 batchId、probeId、source、from、to）/ 新增 |
| DELETE | /api/records/:id | 删除一条记录 |
| GET | /api/releases | 放行台账（支持 batchId、decision、certStatus、receiptStatus、inconsistent），每条附 `certificate`（关联单据、有效单据号、单据与回执状态、对账是否一致） |
| GET / POST | /api/certificates | 放行单清单（支持 batchId、status、receiptStatus、keyword、inconsistent）/ 按放行记录出具，body `{releaseId, issuer, issuedAt?}` |
| GET | /api/certificates/reconcile | 全部单据对账汇总，只看对不上传 `inconsistent=1` |
| GET | /api/certificates/:id | 单据详情（id 或单据号，含快照、发出、回执、撤销信息与逐字段对账） |
| POST | /api/certificates/:id/send | 登记对外发出，body `{receiver, sentAt?, sentBy, channel?}` |
| POST | /api/certificates/:id/receipt | 登记对方回执，body `{status: 已签收\|拒收\|其他, receiptAt?, receivedBy?, note?}` |
| POST | /api/certificates/:id/revoke | 撤销（必须），body `{reason, revokedBy, revokedAt?}`；撤销后才能对同批次出新单 |
| GET | /api/certificates/:id/reconcile | 这张单与台账的逐字段对账结果 |

出错的返回统一是 `{"error":{"code":"...","message":"...","details":{...}}}`，`details` 里会点名是哪个字段没过。
