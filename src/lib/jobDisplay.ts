export function displayName(jobName: string, location: { address: string | null } | null): string {
  return /^job\s/i.test(jobName) && location?.address ? location.address : jobName
}
