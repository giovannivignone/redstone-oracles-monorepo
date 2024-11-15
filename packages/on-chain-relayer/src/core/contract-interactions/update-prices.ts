import { TransactionReceipt } from "@ethersproject/providers";
import { DataPackagesWrapper } from "@redstone-finance/evm-connector";
import {
  convertToTxDeliveryCall,
  TxDeliveryCall,
} from "@redstone-finance/rpc-providers";
import {
  chooseDataPackagesTimestamp,
  DataPackagesResponse,
  isSubsetOf,
} from "@redstone-finance/sdk";
import { loggerFactory, RedstoneCommon } from "@redstone-finance/utils";
import { Contract, providers, utils } from "ethers";
import {
  MentoAdapterBase,
  MultiFeedAdapterWithoutRounds,
  RedstoneAdapterBase,
} from "../../../typechain-types";
import { config } from "../../config";
import { updateUsingOevAuction } from "../../custom-integrations/fastlane/update-using-oev-auction";
import { getSortedOraclesContractAtAddress } from "../../custom-integrations/mento/get-sorted-oracles-contract-at-address";
import { prepareLinkedListLocationsForMentoAdapterReport } from "../../custom-integrations/mento/mento-utils";
import { MultiFeedUpdatePricesArgs, UpdatePricesArgs } from "../../types";
import { getTxDeliveryMan } from "../TxDeliveryManSingleton";

const logger = loggerFactory("updatePrices");

export const updatePrices = async (
  updatePricesArgs: UpdatePricesArgs,
  adapterContract: Contract
) => {
  const dataPackages = await updatePricesArgs.fetchDataPackages();
  const updateTx = await makeUpdateTx(
    updatePricesArgs,
    adapterContract,
    dataPackages
  );

  const txDeliveryMan = getTxDeliveryMan(
    adapterContract.signer,
    adapterContract.provider as providers.JsonRpcProvider
  );

  if (config().oevAuctionUrl) {
    try {
      const updateUsingOevAuctionPromise = updateUsingOevAuction(
        updateTx,
        updatePricesArgs.blockTag,
        adapterContract as RedstoneAdapterBase,
        dataPackages
      );
      const timeout = config().oevTotalTimeout;
      await RedstoneCommon.timeout(
        updateUsingOevAuctionPromise,
        timeout,
        `Updating using OEV auction didn't succeed in ${timeout} [ms].`
      );

      return;
    } catch (error) {
      logger.error(
        `Failed to update using OEV auction, proceeding with standard update, error: ${RedstoneCommon.stringifyError(error)}`
      );
    }
  }
  const updateTxResponse = await txDeliveryMan.deliver(updateTx, () =>
    makeUpdateTx(updatePricesArgs, adapterContract).then((tx) => tx.data)
  );

  // is not using await to not block the main function
  updateTxResponse
    .wait()
    .then((receipt) =>
      logger.log(
        `iteration_block=${updatePricesArgs.blockTag} ${getTxReceiptDesc(receipt)}`
      )
    )
    .catch((error) => describeTxWaitError(error));

  logger.log(
    `Update prices tx delivered hash=${updateTxResponse.hash} gasLimit=${String(
      updateTxResponse.gasLimit
    )} gasPrice=${updateTxResponse.gasPrice?.toString()} maxFeePerGas=${String(
      updateTxResponse.maxFeePerGas
    )} maxPriorityFeePerGas=${String(updateTxResponse.maxPriorityFeePerGas)}`
  );
};

const makeUpdateTx = async (
  args: UpdatePricesArgs,
  contract: Contract,
  initialDataPackages?: DataPackagesResponse
): Promise<TxDeliveryCall> => {
  switch (config().adapterContractType) {
    case "price-feeds":
      return await makePriceFeedUpdateTx(
        args,
        contract as RedstoneAdapterBase,
        initialDataPackages
      );
    case "multi-feed":
      return await makeMultiFeedUpdateTx(
        args as MultiFeedUpdatePricesArgs,
        contract as MultiFeedAdapterWithoutRounds
      );
    case "mento":
      return await makeMentoUpdateTx(args, contract as MentoAdapterBase);
    default:
      throw new Error(
        `Unsupported adapter contract type: ${config().adapterContractType}`
      );
  }
};

const makePriceFeedUpdateTx = async (
  { fetchDataPackages }: UpdatePricesArgs,
  adapterContract: RedstoneAdapterBase,
  initialDataPackages?: DataPackagesResponse
): Promise<TxDeliveryCall> => {
  const dataPackages = initialDataPackages ?? (await fetchDataPackages());
  const dataPackagesWrapper = new DataPackagesWrapper<RedstoneAdapterBase>(
    dataPackages
  );
  const proposedTimestamp = chooseDataPackagesTimestamp(dataPackages);

  dataPackagesWrapper.setMetadataTimestamp(Date.now());
  const wrappedContract =
    dataPackagesWrapper.overwriteEthersContract(adapterContract);

  const txCall = convertToTxDeliveryCall(
    await wrappedContract.populateTransaction["updateDataFeedsValues"](
      proposedTimestamp
    )
  );

  return txCall;
};

const makeMultiFeedUpdateTx = async (
  { dataFeedsToUpdate, fetchDataPackages }: MultiFeedUpdatePricesArgs,
  adapterContract: MultiFeedAdapterWithoutRounds
): Promise<TxDeliveryCall> => {
  let dataFeedsAsBytes32 = dataFeedsToUpdate.map(utils.formatBytes32String);
  const dataPackages = await fetchDataPackages();
  const dataPackagesFeeds = Object.keys(dataPackages);

  //TODO: Multifeed won't work with medium data packages.
  if (!isSubsetOf(new Set(dataPackagesFeeds), new Set(dataFeedsToUpdate))) {
    logger.log(
      `Missing some feeds in the response, will update only for [${dataPackagesFeeds.toString()}]`,
      {
        dataFeedsToUpdate,
        dataPackagesFeeds,
      }
    );

    dataFeedsAsBytes32 = dataPackagesFeeds.map(utils.formatBytes32String);
  }

  const dataPackagesWrapper =
    new DataPackagesWrapper<MultiFeedAdapterWithoutRounds>(dataPackages);

  dataPackagesWrapper.setMetadataTimestamp(Date.now());
  const wrappedContract =
    dataPackagesWrapper.overwriteEthersContract(adapterContract);

  const txCall = convertToTxDeliveryCall(
    await wrappedContract.populateTransaction["updateDataFeedsValuesPartial"](
      dataFeedsAsBytes32
    )
  );

  return txCall;
};

const makeMentoUpdateTx = async (
  { fetchDataPackages }: UpdatePricesArgs,
  mentoAdapter: MentoAdapterBase
): Promise<TxDeliveryCall> => {
  const dataPackagesPromise = fetchDataPackages();
  const blockTag = await mentoAdapter.provider.getBlockNumber();

  const sortedOraclesAddress = await mentoAdapter.getSortedOracles({
    blockTag,
  });
  const sortedOracles = getSortedOraclesContractAtAddress(
    sortedOraclesAddress,
    mentoAdapter.provider
  );
  const maxDeviationAllowed = config().mentoMaxDeviationAllowed;

  const dataPackages = await dataPackagesPromise;
  const dataPackagesWrapper = new DataPackagesWrapper<MentoAdapterBase>(
    dataPackages
  );

  const linkedListPositions =
    await prepareLinkedListLocationsForMentoAdapterReport(
      {
        mentoAdapter,
        dataPackagesWrapper,
        sortedOracles,
      },
      blockTag,
      maxDeviationAllowed
    );
  if (!linkedListPositions) {
    throw new Error(
      `Prices in Sorted Oracles deviated more than ${maxDeviationAllowed}% from RedStone prices`
    );
  }

  dataPackagesWrapper.setMetadataTimestamp(Date.now());
  const wrappedMentoContract =
    dataPackagesWrapper.overwriteEthersContract(mentoAdapter);

  const proposedTimestamp = chooseDataPackagesTimestamp(dataPackages);

  const txCall = convertToTxDeliveryCall(
    await wrappedMentoContract.populateTransaction[
      "updatePriceValuesAndCleanOldReports"
    ](proposedTimestamp, linkedListPositions)
  );

  return txCall;
};

const getTxReceiptDesc = (receipt: TransactionReceipt) => {
  return `Transaction ${receipt.transactionHash} mined with SUCCESS(status: ${
    receipt.status
  }) in block #${receipt.blockNumber}[tx index: ${
    receipt.transactionIndex
  }]. gas_used=${receipt.gasUsed.toString()} effective_gas_price=${receipt.effectiveGasPrice.toString()}`;
};

function describeTxWaitError(error: unknown) {
  logger.error(
    `Failed to await transaction ${RedstoneCommon.stringifyError(error)}`
  );
}
