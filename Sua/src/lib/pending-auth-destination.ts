type AuthDestination = "/setup" | "/home";

let pendingAuthDestination: AuthDestination = "/home";

export function setPendingAuthDestination(destination: AuthDestination) {
  pendingAuthDestination = destination;
}

export function getPendingAuthDestination() {
  return pendingAuthDestination;
}
