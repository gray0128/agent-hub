package api

import (
	"errors"
	"net"
)

const (
	ExitOK              = 0
	ExitRunFailed       = 10
	ExitNeedsApproval   = 20
	ExitWaitTimeout     = 24
	ExitBadUsageOrInput = 64
	ExitNetworkTemp     = 75
	ExitPolicyDenied    = 78
)

func ExitCodeForRunStatus(status string) int {
	switch status {
	case "done":
		return ExitOK
	case "needs_approval":
		return ExitNeedsApproval
	case "failed", "cancelled":
		return ExitRunFailed
	default:
		return ExitWaitTimeout
	}
}

func ExitCodeForError(err error) int {
	if err == nil {
		return ExitOK
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		switch apiErr.Body.Code {
		case "DEPTH_LIMIT_EXCEEDED", "DELEGATION_CYCLE_DETECTED", "FORBIDDEN_SCOPE", "UNAUTHORIZED":
			return ExitPolicyDenied
		case "BAD_REQUEST", "WORKDIR_NOT_FOUND", "WORKDIR_AMBIGUOUS", "NODE_NOT_FOUND", "NOT_FOUND", "INVALID_STATE_TRANSITION", "IDEMPOTENCY_CONFLICT", "DEPENDENCY_CYCLE_DETECTED":
			return ExitBadUsageOrInput
		case "NODE_DRAINING":
			return ExitNetworkTemp
		default:
			if apiErr.HTTPStatus >= 500 {
				return ExitNetworkTemp
			}
			return ExitBadUsageOrInput
		}
	}
	var netErr net.Error
	if errors.As(err, &netErr) {
		return ExitNetworkTemp
	}
	return ExitNetworkTemp
}
