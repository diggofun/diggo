# Meme Mining Game --- Architecture

> Working concept: a Solana memecoin launchpad + DEX where users choose
> a memecoin and "mine" it through a gamified minigame: either **pickaxe
> mining** or **fishing**. The visual theme can change without changing
> the underlying protocol.

## 1. Product thesis

The core loop should feel like Bitcoin mining, but the "hashrate" is
represented by a player's in-game equipment power.

A player:

1.  chooses a memecoin,
2.  assigns their Mining/Fishing Power to it,
3.  waits for periodic blocks,
4.  receives a proportional share of that coin's block reward,
5.  spends some mined tokens to upgrade equipment,
6.  gains more power,
7.  competes for a larger share of future blocks.

The system uses **fixed token supply**. Mining does not mint new tokens.
Rewards are distributed from a program-controlled **Unmined Reserve**
allocated at token creation.

------------------------------------------------------------------------

## 2. Design principles

-   **Fixed supply:** mint authority is permanently disabled after
    launch.
-   **No creator-controlled LP:** creators cannot withdraw
    protocol-created liquidity.
-   **No creator-controlled mining reserve:** the Unmined Reserve is
    controlled by immutable/program-enforced rules.
-   **No guaranteed yield:** equipment represents relative mining power,
    not a promised SOL/APY return.
-   **Proportional blocks:** rewards are distributed according to each
    player's share of total power assigned to a coin.
-   **Finite mining:** when a coin's Unmined Reserve reaches zero, that
    coin becomes `FULLY_MINED`.
-   **Secondary trading continues:** a fully mined token can still trade
    normally; only mining ends.
-   **Token sink:** upgrades recycle part of spent tokens, burn part,
    and optionally collect a small protocol fee.
-   **Creator monetization comes from usage:** creator revenue should
    primarily come from transparent trading fees, not the ability to
    drain reserves or liquidity.

------------------------------------------------------------------------

## 3. High-level architecture

``` text
                         ┌───────────────────────────┐
                         │        WEB / MOBILE       │
                         │                           │
                         │  Launch • Mine • Trade    │
                         │  Equipment • Leaderboard │
                         └─────────────┬─────────────┘
                                       │
                          Wallet sign / read APIs
                                       │
              ┌────────────────────────┴────────────────────────┐
              │                                                 │
      ┌───────▼────────┐                               ┌────────▼────────┐
      │ Backend / API  │                               │ Solana Programs │
      │                │                               │                 │
      │ indexer        │                               │ Token Factory   │
      │ leaderboards   │                               │ Launch Market   │
      │ block scheduler│                               │ Mining Reserve  │
      │ analytics      │                               │ Mining Engine   │
      │ notifications  │                               │ Equipment       │
      └───────┬────────┘                               │ Fee Router      │
              │                                        └────────┬────────┘
              │                                                 │
      ┌───────▼────────┐                               ┌────────▼────────┐
      │ Postgres/Redis │                               │ DEX / AMM / LP  │
      └────────────────┘                               └─────────────────┘
```

The blockchain is the source of truth for ownership, reserves, upgrades,
block claims, burns and fee routing. The backend exists for indexing,
UX, rankings, notifications and caching---not for custody.

------------------------------------------------------------------------

## 4. Token lifecycle

### 4.1 Creation

Creator submits:

-   name,
-   ticker,
-   image/metadata URI,
-   description/socials,
-   optional creator wallet,
-   launch parameters within protocol-approved bounds.

Example:

``` text
Token: FROG
Max supply: 1,000,000,000 FROG
Mint authority: revoked after initialization
Freeze authority: revoked
```

A possible initial allocation for MVP:

``` text
Market / launch allocation     95%
Unmined Reserve                 5%
Creator allocation              0%
Platform allocation             0%
```

The exact percentage should be configurable within conservative protocol
limits. The important property is that the mining reserve is **not a
platform wallet**.

### 4.2 Unmined Reserve

The reserve is held by a PDA/program-controlled token account.

Example:

``` text
FROG Unmined Reserve
Balance: 50,000,000 FROG
Withdraw authority: none
Creator withdrawal: impossible
Platform withdrawal: impossible
Valid exits:
  - block distribution
  - protocol-defined upgrade recycling
```

The UI should explicitly label it:

``` text
⛏ Unmined Supply: 5.00%
🔒 Program Locked
```

rather than presenting it as a team allocation.

------------------------------------------------------------------------

## 5. Launch and liquidity

Liquidity cannot appear from nowhere. If neither creator nor players
manually provide LP, the quote asset must come from buyers, the protocol
treasury, sponsors, or another bootstrap mechanism.

### MVP approach: launch curve → automatic liquidity

1.  Token begins in a protocol launch market.
2.  Early users purchase tokens with SOL.
3.  SOL accumulates inside the launch program.
4.  At a predetermined graduation threshold, the protocol automatically
    creates the token/SOL liquidity position.
5.  LP ownership/control is permanently locked or program-controlled.
6.  Normal secondary-market trading begins.

Example:

``` text
FROG launch
Target: 50 SOL

Accumulated: 50 SOL
        ↓
GRADUATION
        ↓
protocol creates FROG/SOL liquidity
        ↓
secondary trading
```

A later version could replace the continuous curve with a
batch/fair-launch auction if stronger differentiation from existing
launchpads is desired.

------------------------------------------------------------------------

## 6. Mining engine

The game theme is an abstraction over the same engine:

  Protocol concept   Pickaxe theme     Fishing theme
  ------------------ ----------------- ---------------
  Mining power       Mining Power      Fishing Power
  Hardware           Pickaxe           Rod
  Mine               Mine              Pond
  Block              Mining Block      Catch Block
  Unmined supply     Ore Reserve       Fish Reserve
  Upgrade            Pickaxe upgrade   Rod upgrade

Internally use neutral terminology such as `power`, `pool`, `epoch`, and
`block_reward`.

### 6.1 Choosing a coin

A player explicitly assigns power to a token.

``` text
PLAYER POWER: 10,000

FROG:  7,000
DOG:   3,000
PEPE:      0
```

For the simplest MVP, require 100% of power to be assigned to exactly
one token at a time.

### 6.2 Block interval

Each mining pool produces a reward block at a deterministic interval.

Example:

``` text
Block interval: 5 minutes
FROG reward: 10,000 FROG
Network Power: 2,000,000
Player Power: 4,000
Player Share: 0.20%

Player reward:
10,000 × 0.002 = 20 FROG
```

Rewards are proportional, not winner-takes-all.

### 6.3 Reward accounting

Do not loop through every player on-chain at block time.

Instead, use a cumulative reward-per-power accumulator similar to
staking/reward-index systems:

``` text
global_reward_index += block_reward / total_active_power
```

For each position store:

``` text
assigned_power
last_reward_index
pending_reward
```

When the player claims or changes allocation:

``` text
pending += assigned_power
         × (global_reward_index - last_reward_index)
```

This makes reward accounting O(1) per user interaction rather than
O(number_of_players) per block.

------------------------------------------------------------------------

## 7. Epochs and reward reduction

Use epochs so reward issuance becomes progressively slower.

Example:

``` text
Epoch 1: 10,000 FROG / block
Epoch 2:  7,500 FROG / block
Epoch 3:  5,625 FROG / block
Epoch 4:  4,218 FROG / block
```

This is a 25% reduction per epoch rather than a Bitcoin-style 50%
halving.

The "missing" tokens are **not burned**.

If the reward changes:

``` text
10,000 → 7,500
```

the remaining:

``` text
2,500 FROG
```

simply stays in the Unmined Reserve.

Therefore reward reductions extend the lifetime of the mine.

The contract must always enforce:

``` text
block_reward <= remaining_unmined_reserve
```

The final block can distribute the exact remaining balance.

When:

``` text
unmined_reserve == 0
```

status becomes:

``` text
FULLY_MINED
```

No further mining rewards are produced for that token.

Trading remains available.

------------------------------------------------------------------------

## 8. Equipment system

Equipment controls power.

Example progression:

``` text
Level 1  Wooden Pickaxe / Rod       100 Power
Level 2                              140 Power
Level 3                              200 Power
Level 4                              290 Power
Level 5  Iron tier                  420 Power
...
Level 20 Legendary tier          25,000 Power
```

Do not make power growth completely linear. Upgrades should become
progressively more expensive.

Example upgrade:

``` text
Carbon Rod Lv. 9 → Lv. 10

Current Power: 3,400
New Power:     4,000

Cost: 0.20 SOL value
Payment token: FROG
Required: 184,291 FROG
```

The SOL value is a pricing denomination. The player pays with the
selected supported memecoin.

Price conversion must use manipulation-resistant pricing logic with
liquidity/price-safety checks; thin or unsafe pools should not be
eligible for upgrade payments.

------------------------------------------------------------------------

## 9. Upgrade token flow

Recommended starting model:

``` text
100% token payment
        │
        ├── 70% → Unmined Reserve / reward recycle
        │
        ├── 20% → Burn
        │
        └── 10% → Protocol fee
```

Example:

``` text
Upgrade payment: 1,000 FROG

700 FROG → FROG Unmined Reserve
200 FROG → burned permanently
100 FROG → protocol fee vault
```

This creates three effects:

1.  **Recycle:** part of previously mined supply becomes mineable again.
2.  **Deflation:** burn permanently decreases remaining token supply.
3.  **Revenue:** the platform earns from actual game usage.

The protocol should avoid instantly market-selling every token received
as a fee, because that would create predictable sell pressure. Fee
conversion policy should be transparent and rate-limited if conversion
to SOL is required.

------------------------------------------------------------------------

## 10. Fixed supply and burn

No new token units can ever be minted after initialization.

Define:

``` text
MAX_SUPPLY = initial minted supply
```

Burn reduces live supply:

``` text
live_supply =
MAX_SUPPLY - cumulative_burned
```

Recycling does **not** increase supply. It only moves existing tokens
from a player's wallet back into the Unmined Reserve.

Therefore:

``` text
mine → upgrade → recycle
```

does not create inflation.

------------------------------------------------------------------------

## 11. Trading fee model

Illustrative fee structure:

``` text
Total application-level trading fee: 2.00%

1.00% → Protocol
0.50% → Creator
0.50% → Mining ecosystem
```

These numbers are product parameters and must be validated against the
actual AMM/DEX integration and market competitiveness.

Creator fee gives creators a reason to promote long-lived trading
activity without giving them access to LP or mining reserves.

The mining ecosystem share can fund protocol-owned incentives, reserve
replenishment mechanisms, events, or buybacks under transparent rules.

Avoid promising that this fee produces a fixed mining yield.

------------------------------------------------------------------------

## 12. Anti-rug architecture

The protocol should minimize the most obvious creator-controlled rug
vectors.

### Token

``` text
Mint authority: revoked
Freeze authority: revoked
Max supply: fixed
```

### Liquidity

``` text
Creator can withdraw LP: NO
Creator controls LP position: NO
Protocol rules control liquidity: YES
```

### Mining reserve

``` text
Creator withdraw: NO
Platform arbitrary withdraw: NO
Admin emergency drain: NO
Block reward distribution: YES
Upgrade recycle deposits: YES
```

### Creator allocation

Safest default:

``` text
Creator initial allocation: 0%
```

If creator allocations are later supported, require transparent
vesting/locking.

This does not make a token immune to every possible market manipulation
or dump. It specifically removes major protocol-level rug controls.

------------------------------------------------------------------------

## 13. Program/module layout

Suggested Solana program separation:

### `token_factory`

Responsibilities:

-   create mint,
-   mint fixed initial supply,
-   initialize metadata references,
-   allocate launch and Unmined Reserve balances,
-   revoke mint/freeze authorities.

### `launch_market`

Responsibilities:

-   initial token sale,
-   pricing mechanism,
-   SOL custody during bootstrap,
-   graduation threshold,
-   handoff to liquidity creation.

### `liquidity_manager`

Responsibilities:

-   create/initialize AMM liquidity,
-   enforce protocol ownership/locking,
-   track pool address,
-   prevent creator withdrawal.

### `mining_engine`

Responsibilities:

-   register mine/pool,
-   track reserve,
-   block/epoch state,
-   total assigned power,
-   cumulative reward index,
-   claims,
-   fully-mined state.

### `equipment`

Responsibilities:

-   player equipment state,
-   levels,
-   upgrade cost,
-   power calculation,
-   accepted payment token validation,
-   upgrade token routing.

### `fee_router`

Responsibilities:

-   protocol fee accounting,
-   creator fee accounting,
-   mining ecosystem allocation,
-   protocol vault accounting.

Keep authorities minimal and clearly documented.

------------------------------------------------------------------------

## 14. Core accounts/data structures

Conceptual structures:

``` rust
Mine {
    mint
    reserve_vault
    total_power
    reward_index
    current_block_reward
    block_interval
    next_block_at
    epoch
    epoch_ends_at
    reduction_bps
    remaining_reserve
    status
}
```

``` rust
Player {
    owner
    equipment_level
    base_power
}
```

``` rust
MiningPosition {
    owner
    mine
    assigned_power
    last_reward_index
    pending_reward
}
```

``` rust
EquipmentConfig {
    level
    power
    upgrade_cost_sol
}
```

``` rust
TokenConfig {
    mint
    creator
    creator_fee_bps
    liquidity_pool
    mining_reserve
    status
}
```

------------------------------------------------------------------------

## 15. Backend

Recommended stack:

``` text
TypeScript
Node.js
PostgreSQL
Redis
WebSocket/SSE
Solana RPC + event/indexing layer
```

Backend responsibilities:

-   index program events,
-   cache token stats,
-   calculate leaderboards,
-   expose mine discovery endpoints,
-   aggregate historical rewards,
-   push block countdown/state,
-   analytics,
-   notification service,
-   social/share cards.

Backend must **not** be trusted for reward ownership or token custody.

------------------------------------------------------------------------

## 16. Frontend

Suggested:

``` text
Next.js
TypeScript
React
Solana wallet adapter / modern equivalent
WebGL/Canvas only where needed for the minigame
```

Main screens:

### Discover

``` text
🔥 Trending Mines
💎 Highest reward efficiency
🆕 New
⏳ Nearing reduction
🏁 Nearly fully mined
```

### Mine

``` text
FROG
────────────────────────
Your Power       4,000
Network Power    2.0M
Your Share       0.20%

Block Reward     7,500 FROG
Next Block       01:42

Unmined          31.2M FROG

[ START MINING ]
```

### Equipment

``` text
LEVEL 9 → LEVEL 10

Power
3,400 → 4,000

Upgrade
0.20 SOL value

Pay with:
[FROG] [DOG] [OTHER]
```

### Portfolio

-   mined tokens,
-   pending claims,
-   equipment,
-   power allocations,
-   historical rewards,
-   burns caused by upgrades.

### Token page

-   chart,
-   trade,
-   creator,
-   liquidity,
-   Unmined Supply,
-   current block reward,
-   network power,
-   next reduction,
-   mining leaderboard.

------------------------------------------------------------------------

## 17. Game state machine

``` text
TOKEN_CREATED
      │
      ▼
LAUNCHING
      │
      ├── mining may be disabled or heavily limited
      │
      ▼
GRADUATED
      │
      ▼
MINING_ACTIVE
      │
      ├── blocks
      ├── upgrades
      ├── reward reductions
      ├── trading
      │
      ▼
UNMINED_RESERVE = 0
      │
      ▼
FULLY_MINED
      │
      └── trading continues
```

------------------------------------------------------------------------

## 18. Mining allocation state

For MVP:

``` text
one player → one active coin
```

Changing mine:

``` text
1. settle pending reward
2. remove player's power from old mine
3. add player's power to new mine
4. update reward indexes
```

Later:

``` text
FROG 60%
DOG  30%
PEPE 10%
```

can be supported, but it adds complexity and is unnecessary for
validating the core loop.

------------------------------------------------------------------------

## 19. Block processing

A block should not require a centralized cron job to transfer rewards to
every player.

Preferred model:

``` text
current_time >= next_block_at
        ↓
advance mine state
        ↓
calculate blocks elapsed
        ↓
calculate total distributable reward
        ↓
update global reward index
        ↓
decrease reserve accounting
        ↓
advance next_block_at
```

Any valid user interaction can trigger synchronization, or a
permissionless keeper can call it.

The keeper receives no authority over funds.

Multiple elapsed blocks should be processable in one transaction within
safe compute limits.

------------------------------------------------------------------------

## 20. Reward reductions

Each mine has explicit parameters established at launch or inherited
from protocol defaults.

Example:

``` text
Initial reward:      10,000 FROG
Block interval:      5 min
Epoch duration:      7 days
Reduction:           25%
Minimum reward:      protocol-defined
```

UI:

``` text
NEXT REWARD REDUCTION
2d 14h 32m

7,500 → 5,625 FROG/block
```

The event itself becomes part of the game's social loop.

------------------------------------------------------------------------

## 21. Mining profitability

Do not present guaranteed ROI.

Useful metrics:

``` text
Reward per 1,000 Power
Current network power
Remaining reserve
Blocks/day
Current token price
Estimated token units/day
```

If showing fiat/SOL estimates, clearly mark them as estimates based on
current price and current network power.

Avoid:

``` text
Guaranteed 4% daily
Guaranteed passive income
```

Prefer:

``` text
Estimated at current network conditions
```

because both token price and network power can change.

------------------------------------------------------------------------

## 22. Security invariants

These should be enforced and tested as protocol invariants.

``` text
1. total distributed rewards <= available reserve
2. total live supply can never exceed initial max supply
3. burned tokens can never return
4. creator cannot withdraw mining reserve
5. creator cannot withdraw protocol-controlled LP
6. platform cannot arbitrarily seize player rewards
7. power cannot be active in two mines unless allocation explicitly supports it
8. changing mines settles rewards first
9. equipment upgrade cannot create tokens
10. reward calculation cannot depend on an off-chain trusted number
11. unsafe price feeds/pools cannot be used for upgrade valuation
12. fee routing always matches published configuration
```

------------------------------------------------------------------------

## 23. Economic loop

``` text
                  ┌──────────────┐
                  │   TRADING    │
                  └──────┬───────┘
                         │
                       fees
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
          Protocol    Creator    Ecosystem
                                      │
                                      ▼
                             Mining incentives

PLAYER
  │
  ▼
selects FROG
  │
  ▼
assigns Power
  │
  ▼
BLOCK
  │
  ▼
receives FROG
  │
  ├──────────────► KEEP / TRADE
  │
  ▼
UPGRADE EQUIPMENT
  │
  ├── 70% recycle → Unmined Reserve
  ├── 20% burn
  └── 10% protocol fee
  │
  ▼
MORE POWER
  │
  └──────────────► compete for future blocks
```

------------------------------------------------------------------------

## 24. Example: full FROG lifecycle

Initial state:

``` text
Max supply:            1,000,000,000
Launch/market:           950,000,000
Unmined Reserve:          50,000,000
Creator allocation:                0
Platform allocation:               0
```

Mining starts after the configured activation/graduation condition.

``` text
Block 1: 10,000 FROG
Block 2: 10,000 FROG
...
```

After reward reduction:

``` text
Block reward:
10,000 → 7,500

The 2,500 difference remains unmined.
```

Player receives:

``` text
1,000 FROG
```

and uses all of it for an equipment upgrade:

``` text
700 → reserve
200 → burn
100 → protocol
```

Result:

-   700 can be distributed again in future mining blocks,
-   200 no longer exists,
-   100 becomes protocol revenue in FROG,
-   no new FROG was minted.

Eventually:

``` text
Unmined Reserve: 0
Status: FULLY_MINED
```

Players can no longer assign new mining power to FROG for token rewards
and are prompted to choose another active mine.

FROG remains tradable.

------------------------------------------------------------------------

## 25. MVP scope

Build only what is necessary to test whether users enjoy the loop.

### On-chain

-   fixed-supply token creation,
-   launch/bootstrap mechanism,
-   automated/program-controlled liquidity,
-   Unmined Reserve,
-   one active mining allocation per player,
-   proportional block rewards,
-   reward reductions,
-   equipment levels,
-   upgrades paid in supported memecoin,
-   recycle/burn/protocol split,
-   claims,
-   creator/trading fee accounting.

### Frontend

-   wallet connect,
-   launch coin,
-   discover mines,
-   choose coin,
-   mining animation,
-   block countdown,
-   reward display,
-   upgrade equipment,
-   token page,
-   trading,
-   leaderboard.

### Do not build initially

-   boats,
-   multiple equipment slots,
-   clans,
-   NFTs,
-   dozens of biomes,
-   complex quests,
-   paid loot boxes,
-   multi-coin power allocation,
-   elaborate crafting.

Validate the core loop first.

------------------------------------------------------------------------

## 26. Theme decision

The architecture should remain theme-independent.

### Pickaxe version

``` text
Brand language:
Mine
Pickaxe
Mining Power
Ore
Mine
Block
Dig
```

Strong advantage: users immediately understand "mining".

### Fishing version

``` text
Brand language:
Fish
Rod
Fishing Power
Pond
Catch
Catch Block
Cast
```

Strong advantage: more visually distinctive and easier to turn into a
playful viral game.

The protocol code should use neutral names so changing the frontend
theme does not require redesigning the economics.

------------------------------------------------------------------------

## 27. Suggested repository structure

``` text
/apps
  /web
  /api

/programs
  /token-factory
  /launch-market
  /liquidity-manager
  /mining-engine
  /equipment
  /fee-router

/packages
  /sdk
  /types
  /config
  /math
  /ui

/services
  /indexer
  /keeper
  /notifications

/database
  /migrations
  /seeds

/docs
  ARCHITECTURE.md
  TOKENOMICS.md
  SECURITY.md
  API.md
```

------------------------------------------------------------------------

## 28. Decisions still to finalize

Before implementation, lock down:

1.  **Theme:** pickaxe mining vs fishing.
2.  **Brand/name/domain.**
3.  **Initial Unmined Reserve percentage:** e.g. 3--5%.
4.  **Block interval:** e.g. 1, 5 or 10 minutes.
5.  **Initial block reward formula.**
6.  **Epoch length and reduction percentage.**
7.  **Upgrade curve.**
8.  **Upgrade split:** current candidate
    `70% recycle / 20% burn / 10% protocol`.
9.  **Trading fee split:** current candidate
    `1% protocol / 0.5% creator / 0.5% ecosystem`.
10. **Launch mechanism:** curve vs batch auction.
11. **AMM/liquidity integration.**
12. **Rules for valuing memecoin payments in SOL.**
13. **Creator allocation policy.**
14. **Protocol upgradeability vs immutability strategy.**

------------------------------------------------------------------------

## 29. Core product sentence

**Choose a memecoin. Mine it with your equipment. Every block
distributes a finite reserve proportionally to Mining Power. Spend mined
coins to upgrade, recycle supply, burn tokens and compete for a larger
share of future blocks.**

The launchpad and DEX exist underneath this game loop; the game is the
primary user experience.
