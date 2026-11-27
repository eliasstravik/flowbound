One file per workflow, in folders if you like (one folder a play). The path is the workflow's id:
`find-sales-heads.ts` is `find-sales-heads` and exports `findSalesHeads`; `tam-mapping/find-sales-heads.ts` is
`tam-mapping/find-sales-heads`. Each file also has `export const summary` and `export const diagram` (a Mermaid
flowchart, kept in step with the code), written for the people who read it on the page. Run
`npx flowbound docs workflow-sdk` for how to write one.
