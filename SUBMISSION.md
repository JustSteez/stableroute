# Agent Games: Wildcard submission (StableRoute)

Copy-paste answers for the submission form. 

## Agent link
https://github.com/JustSteez/stableroute

## Public endpoint
https://www.stableroute.xyz/agent
Try it: `curl -X POST https://www.stableroute.xyz/agent -H 'content-type: application/json' -d '{"text":"put $10k USDC somewhere safe on Base"}'`
(Demo site: https://www.stableroute.xyz/ · Health: https://www.stableroute.xyz/health · Open API: POST https://www.stableroute.xyz/route)

## Use case
People hold stablecoins as savings, but finding a safe yield is hard. Yield dashboards rank thousands of pools by APY, and the top of the list is usually the worst place to be: farms paying most of their APY in a token that's dumping, rates that spiked last week and won't last, and pools so small your deposit moves the rate. Most people either chase the headline number and get burned, or leave their USDC idle.

StableRoute is a stablecoin yield router. You say "put $10k USDC somewhere safe on Base" (or pick amount, token, risk and chains). It pulls live yields from DeFiLlama, runs six risk checks on every pool, picks the best one that passes, and drafts the deposit (approve exactly the amount, then supply to Aave v3 or Compound v3) for you to sign in your own wallet. It never holds keys or funds. If nothing is safe enough, it says so instead of forcing a pick.

It helps stablecoin holders (including the many people in markets like Nigeria who save in USDT/USDC), small DAOs and treasuries that need a defensible reason for where idle funds went, and other agents or wallets that want a machine-readable "where should this USDC go?" answer.

## Build context
- Node.js service. Data from the DeFiLlama yields API, normalized to whole USD and basis points.
- Six checks per pool, with thresholds set by risk level: pool size, deposit as a share of the pool, share of APY that is organic rather than token emissions, current APY vs the 30-day average, blue-chip protocol, and DeFiLlama's falling-APY prediction.
- Score = 2 × organic APY + reward APY, so emissions count half.
- The LLM (optional, Claude) only turns plain English into parameters. The decision is deterministic code, mirrored one-to-one by the circuit.
- Deposits are unsigned calldata built with ethers: ERC-20 approve for the exact amount, then Aave v3 `supply` or Compound v3 `supply`.
- Agent Games protocol: HMAC-SHA256 verification on the raw body, signed preflight, signed responses, 401 on unsigned requests.
- 10 end-to-end tests, including two that show a dishonest pick cannot be proven.

Key decisions: never custody funds; fail closed; keep the LLM out of the decision; return NO_SAFE_ROUTE rather than a bad pick; show rejected pools and the reasons, not just the winner.

## zkVerify (checkable claim)
Claim: "Given these 8 candidate pools and this risk policy, the picked pool passes all six checks and has the highest score of every pool that passes. If nothing was picked, no pool passed."

- Circom circuit `circuits/route_decision.circom` (~5k constraints), Groth16 on bn128, 12 public signals (zkVerify's Groth16 limit is 16). The policy thresholds and the decision are public; the 8 pools' figures are private inputs bound by an in-circuit Poseidon hash (`dataHash`) of the packed rows plus the SHA-256 of the published snapshot.
- Every answer returns the full snapshot, so anyone can recompute `dataHash` and re-run the six checks; the server does this on every run (`dataHashMatchesSnapshot`).
- Every proof is verified locally, then submitted to zkVerify mainnet through Kurier. The UI shows the job status live.
- Tests show a lying decision can't be proven: picking the emission farm fails, and so does picking a pool that passes but isn't the best.
- Limits, stated plainly: the proof trusts DeFiLlama's numbers (zkTLS on the API response is the next step); the 8-pool shortlist is cut off-circuit but reproducibly; the trusted setup is a single-contributor demo ceremony.

Proof reference (zkVerify mainnet, Finalized):
- Tx: https://zkverify.subscan.io/extrinsic/0x869705c5372e033248016194b88bdc526e7596fdcd69256e9945e88ff7634b9d
- Kurier job: d5e87138-e270-11f1-838e-1e6a0d14f999
- Registered vk hash: 0xd23f1383d13eea2a509eb1ca3e1a567a036d51b87427af9d6998e44b108677fe
