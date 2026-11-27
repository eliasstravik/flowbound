One file per workflow. The file name is the workflow's id: `find-sales-heads.ts` exports `findSalesHeads`.
Each file also has `export const summary` and `export const diagram` (an SVG), written for the people who read it on
the page. Run `npx flowbound docs workflow-sdk` for how to write one.
