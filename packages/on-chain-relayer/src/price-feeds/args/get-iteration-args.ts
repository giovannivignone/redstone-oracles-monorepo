import { makeDataPackagesRequestParams } from "../../core/make-data-packages-request-params";
import { ContractFacade } from "../../facade/ContractFacade";
import { RelayerConfig, ShouldUpdateContext } from "../../types";
import { shouldUpdate } from "../should-update";

export const getIterationArgs = async (
  contractFacade: ContractFacade,
  context: ShouldUpdateContext,
  relayerConfig: RelayerConfig
) => {
  const { shouldUpdatePrices, warningMessage } = await shouldUpdate(
    context,
    relayerConfig
  );

  const updateRequestParams = makeDataPackagesRequestParams(
    relayerConfig,
    context.uniqueSignersThreshold
  );

  return {
    shouldUpdatePrices,
    message: warningMessage,
    args: {
      blockTag: context.blockTag,
      updateRequestParams,
      dataFeedsToUpdate: relayerConfig.dataFeeds,
      fetchDataPackages: async () =>
        await contractFacade
          .getContractParamsProvider(updateRequestParams)
          .requestDataPackages(),
    },
  };
};
