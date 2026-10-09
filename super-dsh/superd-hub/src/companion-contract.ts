/** Browser-safe ctx0 companion status returned by the native unary API. */
export interface BetterDashStatus {
  installed: boolean
  version?: string
  enabled?: boolean
  installing: boolean
  error?: string
  requestedVersion: string
}
