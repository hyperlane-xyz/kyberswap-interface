import { ChainId } from '@kyberswap/ks-sdk-core'
import { WalletClient, formatUnits } from 'viem'

import { ZERO_ADDRESS } from 'constants/index'

import { Quote } from '../registry'
import {
  BaseSwapAdapter,
  Chain,
  Currency,
  NormalizedQuote,
  NormalizedTxResponse,
  QuoteParams,
  SwapStatus,
} from './BaseSwapAdapter'

const HYPERLANE_FEE_TIMEOUT_MS = 4_000
const HYPERLANE_GRAPHQL_API = 'https://api.hyperlane.xyz/v1/graphql'
const HYPERLANE_ROUTE_WHITELIST = ['USDC/eclipsemainnet', 'USDT/eclipsemainnet', 'ETH/viction'] as const
const HYPERLANE_SUPPORTED_CHAIN_NAMES = [
  'arbitrum',
  'avalanche',
  'base',
  'ethereum',
  'hyperevm',
  'linea',
  'monad',
  'optimism',
  'polygon',
  'unichain',
] as const
const HYPERLANE_CHAIN_NAME_BY_CHAIN_ID: Partial<Record<ChainId, string>> = {
  [ChainId.ARBITRUM]: 'arbitrum',
  [ChainId.AVAXMAINNET]: 'avalanche',
  [ChainId.BASE]: 'base',
  [ChainId.BLAST]: 'blast',
  [ChainId.BERA]: 'berachain',
  [ChainId.HYPEREVM]: 'hyperevm',
  [ChainId.LINEA]: 'linea',
  [ChainId.MAINNET]: 'ethereum',
  [ChainId.MONAD]: 'monad',
  [ChainId.MANTLE]: 'mantle',
  [ChainId.MATIC]: 'polygon',
  [ChainId.OPTIMISM]: 'optimism',
  [ChainId.SCROLL]: 'scroll',
  [ChainId.SONIC]: 'sonic',
  [ChainId.UNICHAIN]: 'unichain',
  [ChainId.ZKSYNC]: 'zksync',
}
const HYPERLANE_CHAIN_ID_BY_CHAIN_NAME = Object.fromEntries(
  Object.entries(HYPERLANE_CHAIN_NAME_BY_CHAIN_ID).map(([chainId, chainName]) => [chainName, Number(chainId)]),
) as Record<string, ChainId>
const HYPERLANE_SUPPORTED_CHAIN_IDS = HYPERLANE_SUPPORTED_CHAIN_NAMES.map(
  chainName => HYPERLANE_CHAIN_ID_BY_CHAIN_NAME[chainName],
)

type HyperlaneToken = {
  addressOrDenom: string
  amount: (amount: string) => unknown
  collateralAddressOrDenom?: string
  getConnectionForChain: (chainName: string) => { token: HyperlaneToken } | undefined
  symbol: string
}

type HyperlaneRouteConfigToken = {
  addressOrDenom?: string
  chainName: string
  collateralAddressOrDenom?: string
  connections?: { token: string }[]
}

type HyperlaneRouteConfig = {
  tokens: HyperlaneRouteConfigToken[]
}

type HyperlaneFeeEstimate = {
  interchainQuote: { amount: bigint; token: { symbol: string } }
  localQuote: { amount: bigint; token: { symbol: string } }
  tokenFeeQuote?: { amount: bigint; token: { symbol: string } }
}

type HyperlaneRuntime = {
  routeConfigs: Record<string, HyperlaneRouteConfig>
  warpCore: {
    estimateTransferRemoteFees: (params: {
      destination: string
      originTokenAmount: unknown
      recipient: string
      sender: string
      senderPubKey?: string
    }) => Promise<HyperlaneFeeEstimate>
    findToken: (chainName: string, addressOrDenom?: string) => HyperlaneToken | null
    getTransferRemoteTxs: (params: {
      destination: string
      originTokenAmount: unknown
      recipient: string
      sender: string
      senderPubKey?: string
    }) => Promise<HyperlaneTx[]>
    getTokensForRoute: (origin: string, destination: string) => HyperlaneToken[]
  }
}

type HyperlaneTx = {
  category: string
  transaction: {
    data?: string
    to?: string
    value?: bigint | { hex?: string; toString?: () => string }
  }
  type: string
}

type HyperlaneMessageStatus = {
  destination_chain_id?: number | string | null
  destination_tx_hash?: string | null
  is_delivered: boolean
}

const loadModule = (moduleName: string) =>
  new Function(`return import(${JSON.stringify(moduleName)})`)() as Promise<any>

let hyperlaneRuntimePromise: Promise<HyperlaneRuntime> | undefined

const mergeRouteConfigs = (routeConfigs: HyperlaneRouteConfig[]): HyperlaneRouteConfig => {
  const mergedTokens = new Map<string, HyperlaneRouteConfigToken>()

  for (const routeConfig of routeConfigs) {
    for (const token of routeConfig.tokens) {
      const key = `${token.chainName}|${token.addressOrDenom || ''}`
      const existing = mergedTokens.get(key)
      if (!existing) {
        mergedTokens.set(key, {
          ...token,
          connections: [...(token.connections || [])],
        })
        continue
      }

      const connections = new Map(
        [...(existing.connections || []), ...(token.connections || [])].map(connection => [
          connection.token,
          connection,
        ]),
      )

      mergedTokens.set(key, {
        ...existing,
        ...token,
        connections: [...connections.values()],
      })
    }
  }

  return { tokens: [...mergedTokens.values()] }
}

const getHyperlaneRuntime = () => {
  if (!hyperlaneRuntimePromise) {
    hyperlaneRuntimePromise = (async (): Promise<HyperlaneRuntime> => {
      const registry = (await loadModule('@hyperlane-xyz/registry')) as {
        chainAddresses: Record<string, { mailbox: string }>
        chainMetadata: Record<string, Record<string, unknown>>
        warpRouteConfigs: Record<string, HyperlaneRouteConfig>
      }
      const sdk = await loadModule('@hyperlane-xyz/sdk')

      const routeConfigs: Record<string, HyperlaneRouteConfig> = Object.fromEntries(
        HYPERLANE_ROUTE_WHITELIST.flatMap(routeId => {
          const routeConfig = registry.warpRouteConfigs[routeId]
          if (!routeConfig) {
            console.warn(`[Hyperlane] Whitelisted route ${routeId} is missing from installed registry package`)
            return []
          }

          const tokens = routeConfig.tokens
            .filter(token => token.chainName in HYPERLANE_CHAIN_ID_BY_CHAIN_NAME)
            .map(token => ({
              ...token,
              connections: token.connections?.filter(routeConnection => {
                const parsedConnection = sdk.parseTokenConnectionId(routeConnection.token)
                return parsedConnection.chainName in HYPERLANE_CHAIN_ID_BY_CHAIN_NAME
              }),
            }))

          return tokens.length >= 2 ? [[routeId, { ...routeConfig, tokens }]] : []
        }),
      )
      const routeChainNames = Array.from(
        new Set<string>(
          Object.values(routeConfigs).flatMap(routeConfig => routeConfig.tokens.map(token => token.chainName)),
        ),
      )
      const metadata = Object.fromEntries(
        routeChainNames.map(chainName => [
          chainName,
          {
            ...registry.chainMetadata[chainName],
            mailbox: registry.chainAddresses[chainName].mailbox,
          },
        ]),
      )

      const multiProvider = new sdk.MultiProtocolProvider(metadata)
      const warpCore = sdk.WarpCore.FromConfig(multiProvider, mergeRouteConfigs(Object.values(routeConfigs)))

      return {
        routeConfigs,
        warpCore,
      }
    })().catch(error => {
      hyperlaneRuntimePromise = undefined
      throw error
    })
  }

  return hyperlaneRuntimePromise
}

const getTokenAddress = (token?: Currency) => {
  if (!token) return ''

  return (
    ('wrapped' in token ? token.wrapped.address : undefined) ||
    ('address' in token ? token.address : undefined) ||
    ('id' in token ? token.id : undefined) ||
    ('assetId' in token ? token.assetId : undefined) ||
    ('isNative' in token && token.isNative ? token.symbol : undefined) ||
    ''
  )
}

const addressesEqual = (a?: string | null, b?: string | null) => {
  if (!a || !b) return false
  if (a === b) return true
  if (a.startsWith('0x') && b.startsWith('0x')) return a.toLowerCase() === b.toLowerCase()
  return false
}

const tokenMatchesCurrency = (token: HyperlaneToken | undefined | null, currency?: Currency) => {
  if (!token || !currency) return false

  const currencyAddress = getTokenAddress(currency)
  return (
    addressesEqual(token.addressOrDenom, currencyAddress) ||
    addressesEqual(token.collateralAddressOrDenom, currencyAddress)
  )
}

const getHyperlaneChainName = (chain: Chain) =>
  typeof chain === 'number' ? HYPERLANE_CHAIN_NAME_BY_CHAIN_ID[chain as ChainId] : undefined

const resolveRoute = async (params: Pick<QuoteParams, 'fromChain' | 'toChain' | 'fromToken' | 'toToken'>) => {
  const origin = getHyperlaneChainName(params.fromChain)
  const destination = getHyperlaneChainName(params.toChain)
  if (!origin || !destination) return undefined

  const { routeConfigs, warpCore } = await getHyperlaneRuntime()
  const originTokenAddress = getTokenAddress(params.fromToken)
  const originTokens = warpCore.getTokensForRoute(origin, destination)
  const originToken =
    warpCore.findToken(origin, originTokenAddress) ||
    originTokens.find((token: HyperlaneToken) => addressesEqual(token.collateralAddressOrDenom, originTokenAddress))
  const destinationToken = originToken?.getConnectionForChain(destination)?.token

  if (!originToken || !tokenMatchesCurrency(destinationToken, params.toToken)) return undefined

  const routeId = Object.entries(routeConfigs).find(([, routeConfig]) => {
    const routeOriginToken = routeConfig.tokens.find(
      token =>
        token.chainName === origin &&
        (addressesEqual(token.addressOrDenom, originToken.addressOrDenom) ||
          addressesEqual(token.collateralAddressOrDenom, originToken.collateralAddressOrDenom)),
    )
    const routeDestinationToken = routeConfig.tokens.find(
      token =>
        token.chainName === destination &&
        (addressesEqual(token.addressOrDenom, destinationToken?.addressOrDenom) ||
          addressesEqual(token.collateralAddressOrDenom, destinationToken?.collateralAddressOrDenom)),
    )
    return routeOriginToken && routeDestinationToken
  })?.[0]

  if (!routeId) return undefined

  return {
    destination,
    destinationToken: destinationToken as HyperlaneToken,
    origin,
    originToken,
    routeId,
  }
}

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number) =>
  Promise.race<T>([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error('Hyperlane fee quote timed out')), timeoutMs)
    }),
  ])

const getTransferTxs = (txs: HyperlaneTx[]) => txs.filter(tx => tx.category !== 'approval')

const getSpender = (txs: HyperlaneTx[]) => getTransferTxs(txs)[0]?.transaction.to || ZERO_ADDRESS

const getTxValue = (value?: HyperlaneTx['transaction']['value']) => {
  if (!value) return 0n
  if (typeof value === 'bigint') return value
  if (typeof value === 'object' && value.hex) return BigInt(value.hex)
  return BigInt(value.toString?.() || 0)
}

const toBytea = (hash: string) => `\\x${hash.replace(/^0x/, '')}`

const fromBytea = (hash?: string | null) => (hash ? `0x${hash.replace(/^\\x/, '')}` : '')

const getExplorerChainId = (chain: Chain) => ('number' === typeof chain ? chain : undefined)

const fetchMessageStatus = async (
  sourceTxHash: string,
  targetChain: Chain,
): Promise<HyperlaneMessageStatus | undefined> => {
  const destinationChainId = getExplorerChainId(targetChain)
  if (!destinationChainId) return undefined

  const query = `
    query HyperlaneMessageStatus($originTxHash: bytea!) {
      message_view(
        limit: 10
        order_by: { send_occurred_at: desc }
        where: {
          origin_tx_hash: { _eq: $originTxHash }
        }
      ) {
        destination_chain_id
        destination_tx_hash
        is_delivered
      }
    }
  `

  const response = await fetch(HYPERLANE_GRAPHQL_API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: {
        originTxHash: toBytea(sourceTxHash),
      },
    }),
  })

  if (!response.ok) {
    throw new Error(`Hyperlane status query failed with ${response.status}`)
  }

  const body = await response.json()
  return body?.data?.message_view?.find(
    (message: HyperlaneMessageStatus) => Number(message.destination_chain_id) === destinationChainId,
  )
}

export class HyperlaneAdapter extends BaseSwapAdapter {
  getName(): string {
    return 'Hyperlane'
  }

  getIcon(): string {
    return 'https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/main/chains/arbitrum/logo.svg'
  }

  getSupportedChains(): Chain[] {
    return HYPERLANE_SUPPORTED_CHAIN_IDS
  }

  getSupportedTokens(_sourceChain: Chain, _destChain: Chain): Currency[] {
    return []
  }

  canSupport(_category: string, tokenIn?: Currency, tokenOut?: Currency): boolean {
    if (!tokenIn || !tokenOut) return true

    return (
      'chainId' in tokenIn &&
      'chainId' in tokenOut &&
      tokenIn.chainId !== tokenOut.chainId &&
      HYPERLANE_SUPPORTED_CHAIN_IDS.includes(tokenIn.chainId as ChainId) &&
      HYPERLANE_SUPPORTED_CHAIN_IDS.includes(tokenOut.chainId as ChainId)
    )
  }

  async getQuote(params: QuoteParams): Promise<NormalizedQuote> {
    const route = await resolveRoute(params)
    if (!route) {
      throw new Error('No supported Hyperlane route found for the selected chain and token pair.')
    }

    let feeEstimate: HyperlaneFeeEstimate | undefined
    let feeQuoteError: string | undefined
    let preparedTxs: HyperlaneTx[] | undefined

    try {
      feeEstimate = await withTimeout(
        (
          await getHyperlaneRuntime()
        ).warpCore.estimateTransferRemoteFees({
          destination: route.destination,
          originTokenAmount: route.originToken.amount(params.amount),
          recipient: params.recipient,
          sender: params.sender,
          senderPubKey: params.publicKey,
        }),
        HYPERLANE_FEE_TIMEOUT_MS,
      )
    } catch (error) {
      feeQuoteError = error instanceof Error ? error.message : 'Unable to estimate Hyperlane transfer fees.'
    }

    try {
      preparedTxs = await (
        await getHyperlaneRuntime()
      ).warpCore.getTransferRemoteTxs({
        destination: route.destination,
        originTokenAmount: route.originToken.amount(params.amount),
        recipient: params.recipient,
        sender: params.sender,
        senderPubKey: params.publicKey,
      })
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Unable to prepare Hyperlane transfer transactions.')
    }

    const outputAmount = BigInt(params.amount)
    const formattedInputAmount = formatUnits(BigInt(params.amount), params.fromToken.decimals)
    const formattedOutputAmount = formatUnits(outputAmount, params.toToken.decimals)
    const inputUsd = params.tokenInUsd * +formattedInputAmount
    const outputUsd = params.tokenOutUsd ? params.tokenOutUsd * +formattedOutputAmount : inputUsd

    return {
      quoteParams: params,
      outputAmount,
      formattedOutputAmount,
      inputUsd,
      outputUsd,
      priceImpact: !inputUsd || !outputUsd ? NaN : ((inputUsd - outputUsd) * 100) / inputUsd,
      rate: +formattedOutputAmount / +formattedInputAmount,
      gasFeeUsd: 0,
      timeEstimate: 300,
      contractAddress: getSpender(preparedTxs),
      rawQuote: {
        type: 'warp-core',
        source: 'hyperlane-registry',
        route: route.routeId,
        sourceChain: route.origin,
        destinationChain: route.destination,
        sourceToken: route.originToken.addressOrDenom,
        sourceCollateralToken: route.originToken.collateralAddressOrDenom,
        destinationToken: route.destinationToken.addressOrDenom,
        destinationCollateralToken: route.destinationToken.collateralAddressOrDenom,
        interchainQuote: feeEstimate?.interchainQuote.amount.toString(),
        interchainQuoteToken: feeEstimate?.interchainQuote.token.symbol,
        localQuote: feeEstimate?.localQuote.amount.toString(),
        localQuoteToken: feeEstimate?.localQuote.token.symbol,
        tokenFeeQuote: feeEstimate?.tokenFeeQuote?.amount.toString(),
        tokenFeeQuoteToken: feeEstimate?.tokenFeeQuote?.token.symbol,
        feeQuoteError,
        preparedTxCategories: preparedTxs.map(tx => tx.category),
      },
      protocolFee: 0,
      platformFeePercent: (params.feeBps * 100) / 10_000,
    }
  }

  async executeSwap({ quote }: Quote, walletClient: WalletClient): Promise<NormalizedTxResponse> {
    const route = await resolveRoute(quote.quoteParams)
    if (!route) throw new Error('Unsupported Hyperlane route.')

    const account = walletClient.account?.address
    if (!account) throw new Error('WalletClient account is not defined')

    const txs = await (
      await getHyperlaneRuntime()
    ).warpCore.getTransferRemoteTxs({
      destination: route.destination,
      originTokenAmount: route.originToken.amount(quote.quoteParams.amount),
      recipient: quote.quoteParams.recipient,
      sender: account,
      senderPubKey: quote.quoteParams.publicKey,
    })

    const executableTxs = getTransferTxs(txs)
    if (!executableTxs.length) throw new Error('No executable Hyperlane transactions found after approval filtering.')

    const hashes: string[] = []
    for (const tx of executableTxs) {
      if (!tx.transaction.to || !tx.transaction.data) throw new Error('Hyperlane transaction payload is incomplete.')
      const hash = await walletClient.sendTransaction({
        account,
        chain: undefined,
        data: tx.transaction.data as `0x${string}`,
        to: tx.transaction.to as `0x${string}`,
        value: getTxValue(tx.transaction.value),
      })
      hashes.push(hash)
    }

    const sourceTxHash = hashes[hashes.length - 1]

    return {
      sender: quote.quoteParams.sender,
      id: sourceTxHash,
      sourceTxHash,
      adapter: this.getName(),
      sourceChain: quote.quoteParams.fromChain,
      targetChain: quote.quoteParams.toChain,
      inputAmount: quote.quoteParams.amount,
      outputAmount: quote.outputAmount.toString(),
      sourceToken: quote.quoteParams.fromToken,
      targetToken: quote.quoteParams.toToken,
      timestamp: Date.now(),
      amountInUsd: quote.inputUsd,
      amountOutUsd: quote.outputUsd,
      platformFeePercent: quote.platformFeePercent,
      recipient: quote.quoteParams.recipient,
    }
  }

  async getTransactionStatus(params: NormalizedTxResponse): Promise<SwapStatus> {
    try {
      const message = await fetchMessageStatus(params.sourceTxHash, params.targetChain)
      if (!message) return { txHash: params.targetTxHash || '', status: 'Processing' }

      return {
        txHash: fromBytea(message.destination_tx_hash) || params.targetTxHash || '',
        status: message.is_delivered ? 'Success' : 'Processing',
      }
    } catch (error) {
      console.error('[Hyperlane] Failed to fetch message status', error)
      return {
        txHash: params.targetTxHash || '',
        status: 'Processing',
      }
    }
  }
}
