pragma circom 2.1.6;
include "circomlib/circuits/comparators.circom";

// StableRoute: route-decision circuit.
//
// Claim proven: "Given these N candidate stablecoin pools (bound to snapshotHash)
// and this risk policy, the pool StableRoute picked passes every policy check and
// has the highest risk-adjusted score of all pools that pass. If it picked nothing,
// then no pool passed."
//
// Every signal is public on purpose: anyone can read the candidate figures and the
// policy from the proof's public signals and re-run the rules by hand.
//
// Units: tvl and amount in whole USD; base/reward/mean30 in basis points (5.23% = 523).
// Score = 2 * baseApy + rewardApy  (token-emission rewards count half: they are
// paid in a volatile token and often switch off).

template RouteDecision(N) {
    // ---- data (public) ----
    signal input snapshotHash;       // first 248 bits of sha256(canonical candidate JSON)
    signal input present[N];         // 1 = real candidate, 0 = padding
    signal input tvl[N];
    signal input base[N];
    signal input reward[N];
    signal input mean30[N];
    signal input blue[N];            // 1 = protocol on the blue-chip list
    signal input down[N];            // 1 = DeFiLlama predicts APY falling

    // ---- policy (public) ----
    signal input amount;             // USD the user wants to deposit
    signal input minTvl;             // USD
    signal input capBps;             // max share of a pool's TVL the deposit may be (100 = 1%)
    signal input minBaseShareBps;    // min share of APY that must be organic (8000 = 80%)
    signal input maxSpikePct;        // current APY may be at most this % of 30-day mean (200 = 2x)
    signal input requireBlue;        // 1 = only blue-chip protocols
    signal input allowDown;          // 1 = allow pools predicted to fall

    // ---- decision (public) ----
    signal input hasPick;
    signal input pick;

    signal output eligibleMask;
    signal output chosenScore;

    // binary checks
    hasPick * (hasPick - 1) === 0;
    requireBlue * (requireBlue - 1) === 0;
    allowDown * (allowDown - 1) === 0;
    component nz = IsZero(); nz.in <== snapshotHash; nz.out === 0;

    // range-bind policy numbers so comparisons are sound
    component rAmt = Num2Bits(48); rAmt.in <== amount;
    component rMin = Num2Bits(48); rMin.in <== minTvl;
    component rCap = Num2Bits(14); rCap.in <== capBps;
    component rShr = Num2Bits(14); rShr.in <== minBaseShareBps;
    component rSpk = Num2Bits(16); rSpk.in <== maxSpikePct;

    component rT[N]; component rB[N]; component rR[N]; component rM[N];
    component tvlOk[N]; component capOk[N]; component shareOk[N]; component spikeOk[N];
    component isPick[N]; component ge[N];

    signal elig[N]; signal e1[N]; signal e2[N]; signal e3[N]; signal e4[N]; signal e5[N];
    signal blueOk[N]; signal downOk[N];
    signal score[N]; signal escore[N];
    signal pickScore[N]; signal pickElig[N];

    var sumPick = 0; var accScore = 0; var accElig = 0; var mask = 0;

    for (var i = 0; i < N; i++) {
        present[i] * (present[i] - 1) === 0;
        blue[i] * (blue[i] - 1) === 0;
        down[i] * (down[i] - 1) === 0;
        rT[i] = Num2Bits(48); rT[i].in <== tvl[i];
        rB[i] = Num2Bits(20); rB[i].in <== base[i];
        rR[i] = Num2Bits(20); rR[i].in <== reward[i];
        rM[i] = Num2Bits(20); rM[i].in <== mean30[i];

        // 1. deep enough pool
        tvlOk[i] = GreaterEqThan(64); tvlOk[i].in[0] <== tvl[i]; tvlOk[i].in[1] <== minTvl;
        // 2. deposit is a small slice of the pool: amount * 10000 <= tvl * capBps
        capOk[i] = LessEqThan(64); capOk[i].in[0] <== amount * 10000; capOk[i].in[1] <== tvl[i] * capBps;
        // 3. yield is mostly organic: base * 10000 >= minShare * (base + reward)
        shareOk[i] = GreaterEqThan(64);
        shareOk[i].in[0] <== base[i] * 10000;
        shareOk[i].in[1] <== minBaseShareBps * (base[i] + reward[i]);
        // 4. no APY spike: (base + reward) * 100 <= maxSpikePct * mean30
        spikeOk[i] = LessEqThan(64);
        spikeOk[i].in[0] <== (base[i] + reward[i]) * 100;
        spikeOk[i].in[1] <== maxSpikePct * mean30[i];
        // 5. blue-chip only (if required)
        blueOk[i] <== 1 - requireBlue * (1 - blue[i]);
        // 6. not predicted to fall (unless allowed)
        downOk[i] <== 1 - (1 - allowDown) * down[i];

        e1[i] <== present[i] * tvlOk[i].out;
        e2[i] <== e1[i] * capOk[i].out;
        e3[i] <== e2[i] * shareOk[i].out;
        e4[i] <== e3[i] * spikeOk[i].out;
        e5[i] <== e4[i] * blueOk[i];
        elig[i] <== e5[i] * downOk[i];

        score[i] <== 2 * base[i] + reward[i];
        escore[i] <== elig[i] * score[i];

        // nothing picked => nothing was eligible
        (1 - hasPick) * elig[i] === 0;

        isPick[i] = IsEqual(); isPick[i].in[0] <== pick; isPick[i].in[1] <== i;
        pickScore[i] <== isPick[i].out * escore[i];
        pickElig[i] <== isPick[i].out * elig[i];
        sumPick += isPick[i].out;
        accScore += pickScore[i];
        accElig += pickElig[i];
        mask += elig[i] * (1 << i);
    }

    sumPick === 1;                         // pick is a valid index
    hasPick * (1 - accElig) === 0;         // picked pool passed every check
    chosenScore <== hasPick * accScore;

    for (var i = 0; i < N; i++) {          // and beat (or tied) every eligible pool
        ge[i] = GreaterEqThan(64); ge[i].in[0] <== chosenScore; ge[i].in[1] <== escore[i];
        hasPick * (1 - ge[i].out) === 0;
    }
    eligibleMask <== mask;
}

component main {public [snapshotHash, present, tvl, base, reward, mean30, blue, down,
    amount, minTvl, capBps, minBaseShareBps, maxSpikePct, requireBlue, allowDown, hasPick, pick]} = RouteDecision(8);
