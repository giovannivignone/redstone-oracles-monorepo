import { IPricesContractAdapter } from "@redstone-finance/sdk";
import { hexlify, hexZeroPad } from "ethers/lib/utils";
import { readFileSync } from "fs";
import {
  Account,
  BytesLike,
  ContractFactory,
  DeployContractOptions,
  StorageSlot,
} from "fuels";
import path from "path";
import { PricesAbi, PricesAbi__factory } from "../autogenerated";
import { FuelContractConnector } from "../FuelContractConnector";
import { FuelPricesContractAdapter } from "./FuelPricesContractAdapter";
import { FuelPricesContract } from "./FuelPricesContractConnector";

const PRICES_CONTRACT_BINARY = "../autogenerated/prices.bin";

export interface PricesContractDeployParameters {
  signers: string[];
  signerCountThreshold: number;
  contractBinary?: Promise<Buffer>;
  fakeTimestamp?: number;
  salt?: BytesLike;
}

export class FuelPricesContractDeployer extends FuelContractConnector<IPricesContractAdapter> {
  private contract?: FuelPricesContract;

  constructor(
    wallet: Account,
    private parameters: PricesContractDeployParameters
  ) {
    super(wallet);
  }

  async getContract(): Promise<FuelPricesContract> {
    if (this.contract) {
      return this.contract;
    }

    this.contract = await this.deployPricesContract();

    await ((await this.getAdapter()) as FuelPricesContractAdapter).init(
      this.parameters.signers,
      this.parameters.signerCountThreshold
    );

    return this.contract;
  }

  async getAdapter(): Promise<IPricesContractAdapter> {
    return new FuelPricesContractAdapter(
      await this.getContract(),
      this.getGasLimit()
    );
  }

  private async deployPricesContract(): Promise<FuelPricesContract> {
    let bytecode = await this.parameters.contractBinary;

    if (!bytecode) {
      const pricesPath = path.join(__dirname, PRICES_CONTRACT_BINARY);
      bytecode = readFileSync(pricesPath);
    }

    const factory = new ContractFactory(
      bytecode,
      PricesAbi__factory.abi,
      this.wallet
    );
    const storageSlots = this.getStorageSlots();

    const options: DeployContractOptions = { storageSlots };

    if (this.parameters.salt) {
      options["salt"] = this.parameters.salt;
    }

    const deployResult = await factory.deployContract<PricesAbi>(options);
    const { contract } = await deployResult.waitForResult();

    const adapter = new FuelPricesContractAdapter(
      contract as unknown as FuelPricesContract,
      this.getGasLimit()
    );

    await adapter.init(
      this.parameters.signers,
      this.parameters.signerCountThreshold
    );

    return contract;
  }

  private getStorageSlots() {
    const FAKE_TIMESTAMP_KEY = "0x66616b655f74696d657374616d70"; // fake_timestamp
    const storageSlots: StorageSlot[] = [];

    if (this.parameters.fakeTimestamp != null) {
      storageSlots.push({
        key: FAKE_TIMESTAMP_KEY,
        value: hexlify(this.parameters.fakeTimestamp),
      });
    }

    return PricesAbi__factory.storageSlots.concat(
      storageSlots.map(({ key, value }) => {
        return {
          key: hexZeroPad(key, 32),
          value: hexZeroPad(value, 32),
        };
      })
    );
  }
}
