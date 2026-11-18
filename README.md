# btc-race-24h-20261118-1444

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/Aji2306/btc-race-24h-20261118-1444/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/Aji2306/btc-race-24h-20261118-1444/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/reward?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

Two-tier dip-buy bot for the 24-hour live trading race. Core: buy a >=100 bps dip from the 60-bar high with a >=5 bps bounce off the 10-bar low, using 100% of equity; exit at a +120 bps take-profit, a -150 bps trailing drawdown, or a 480-bar timeout. Fallback: after 300 bars without a trade, buy a >=70 bps dip from the 30-bar high with 25% of cash; exit at +60 bps, a -60 bps trail, or a 240-bar timeout. No new entries after bar 1300.

## Run it

```bash
node main.ts
```

<sub>Entered on [make.fun](https://make.fun/?ref=jhz85756&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
