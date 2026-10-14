# scheduled-check

Coalesces scheduled checks while preserving the earliest requested deadline.

## Install

This private workspace library is consumed through `workspace:^`.

## Usage

Create a scheduled check, request a delay, and clear it when its owner stops. The callback owns readiness and rescheduling; the timer does not keep Node running.
