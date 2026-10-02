import type { SearchProjection, SearchRecoveryRequest } from "./event-contract";

export interface SearchRecoverySteps {
	createLatestSubscription(): Promise<string>;
	readDocuments(): Promise<SearchProjection["documents"]>;
	commit(request: SearchRecoveryRequest): Promise<Response>;
}

export async function recoverSearchProjection(previousSubscription: string, steps: SearchRecoverySteps): Promise<Response> {
	// Subscribe first: writes during the snapshot remain available for replay.
	const subscription = await steps.createLatestSubscription();
	const documents = await steps.readDocuments();
	return steps.commit({ previousSubscription, subscription, documents });
}
