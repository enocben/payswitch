import { Global, Module } from "@nestjs/common";
import { PayswitchConfig } from "./payswitch-config";

/** Config typée visible de tous les modules (évite les injecteurs aveugles). */
@Global()
@Module({
  providers: [PayswitchConfig],
  exports: [PayswitchConfig],
})
export class PayswitchConfigModule {}
