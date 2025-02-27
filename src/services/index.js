export * as AuthorizationService from './auth'
export * as ClusterService from './cluster'
export * as EventService from './event-bus'
export * as StorageService from './persistence'
export { default as CircuitBreaker } from '../domain/circuit-breaker'

import { dns, whois } from './middleware/network/dns'
export const DnsService = dns
export const WhoIsService = whois

import { initCertificateService } from './cert'
export const CertificateService = {
  provisionCert: initCertificateService(dns, whois)
}

import * as MeshServices from './service-mesh'

const config = require('../config').hostConfig
const designatedService = config.services.activeServiceMesh

/**
 * Which mesh service implementations are enabled?
 */
const enabledServices = Object.entries(config.services.serviceMesh)
  .filter(([, v]) => v.enabled)
  .map(([k]) => k) || ['WebSwitch']

/**
 * Which mesh service do we use?
 */
const service = enabledServices.includes(designatedService)
  ? designatedService
  : 'WebSwitch'

export const ServiceMeshPlugin = MeshServices[service]
