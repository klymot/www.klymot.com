package main

import (
	"runtime"
	"sync"
	"sync/atomic"
	"time"
)

// calcQueue limits concurrent aggregate computations and rejects requests
// when the estimated wait exceeds a configured ceiling.
//
// Concurrency model: a buffered channel acts as a semaphore.  pending counts
// every goroutine that has reserved a position (whether waiting for a slot or
// currently running), so the queue depth check is lock-free and accurate.
//
// Wait estimate: ceil(pending / n) * ewma — how many "rounds" of n parallel
// slots are needed before the new request can complete.  The ewma is an
// exponentially weighted moving average of recent computation times.
type calcQueue struct {
	sem     chan struct{}
	pending atomic.Int64

	mu        sync.Mutex
	ewma      float64 // seconds; updated after every completed computation
	ewmaReady bool    // false until the first sample arrives

	alpha   float64 // EWMA smoothing factor (higher = more reactive)
	maxWait float64 // seconds; requests whose estimate exceeds this are rejected
}

// newCalcQueue creates a queue with the given concurrency limit and wait
// ceiling.  maxConcurrent <= 0 defaults to runtime.NumCPU() (minimum 1).
func newCalcQueue(maxConcurrent int, maxWaitSecs float64) *calcQueue {
	if maxConcurrent <= 0 {
		maxConcurrent = runtime.NumCPU()
		if maxConcurrent < 1 {
			maxConcurrent = 1
		}
	}
	return &calcQueue{
		sem:     make(chan struct{}, maxConcurrent),
		alpha:   0.1,
		maxWait: maxWaitSecs,
	}
}

// concurrency returns the maximum number of simultaneous computations.
func (q *calcQueue) concurrency() int { return cap(q.sem) }

// currentEWMA returns the current EWMA of computation time in seconds.
// Returns 0 before the first sample has been recorded.
func (q *calcQueue) currentEWMA() float64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.ewma
}

// run executes fn under the concurrency limit.  Returns (true, elapsed, 0) on
// success, or (false, 0, estimatedWaitSecs) when the queue is too deep.  The
// estimate is only reliable once the EWMA has at least one sample; before that
// every request is admitted.
func (q *calcQueue) run(fn func()) (ran bool, elapsed time.Duration, retryAfter float64) {
	pending := q.pending.Add(1)

	q.mu.Lock()
	ewma := q.ewma
	ready := q.ewmaReady
	q.mu.Unlock()

	if ready {
		n := int64(cap(q.sem))
		// Round up to the number of full parallel rounds needed.
		rounds := (pending + n - 1) / n
		est := float64(rounds) * ewma
		if est > q.maxWait {
			q.pending.Add(-1)
			return false, 0, est
		}
	}

	q.sem <- struct{}{} // block until a slot is free

	start := time.Now()
	fn()
	elapsed = time.Since(start)

	<-q.sem
	q.pending.Add(-1)

	sample := elapsed.Seconds()
	q.mu.Lock()
	if !q.ewmaReady {
		q.ewma = sample
		q.ewmaReady = true
	} else {
		q.ewma = q.alpha*sample + (1-q.alpha)*q.ewma
	}
	q.mu.Unlock()

	return true, elapsed, 0
}
