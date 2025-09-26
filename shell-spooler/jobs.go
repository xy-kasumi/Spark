// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"fmt"
	"sync"
	"time"

	"shell-spooler/comm"
)

type JobStatus string

const (
	JobWaiting   JobStatus = "WAITING"
	JobRunning   JobStatus = "RUNNING"
	JobCompleted JobStatus = "COMPLETED"
	JobCanceled  JobStatus = "CANCELED"
)

type Job struct {
	ID          string
	Commands    []string
	Signals     map[string]float32
	Status      JobStatus
	TimeAdded   time.Time
	TimeStarted *time.Time
	TimeEnded   *time.Time
}

// JobSched stores list of jobs and manage their execution
// ~unsafe methods are not mutex-protected, caller must protect with mutex
type JobSched struct {
	mu        sync.Mutex
	jobs      []Job
	nextJobID int

	commInstance *comm.Comm
}

// Create & start running new scheduler. At most one scheduler should be created for a single Comm instance.
func InitJobSched(commInstance *comm.Comm) *JobSched {
	sched := &JobSched{
		nextJobID:    1,
		commInstance: commInstance,
	}
	go sched.keepExecutingJobs()
	return sched
}

func (js *JobSched) issueNewJobIDUnsafe() string {
	jobID := fmt.Sprintf("jb%d", js.nextJobID)
	js.nextJobID++
	return jobID
}

func (js *JobSched) findPendingJobUnsafe() *Job {
	for _, job := range js.jobs {
		if job.Status == JobWaiting || job.Status == JobRunning {
			return &job
		}
	}
	return nil
}

func (js *JobSched) findRunningJobUnsafe() *Job {
	for i := range js.jobs {
		if js.jobs[i].Status == JobRunning {
			return &js.jobs[i]
		}
	}
	return nil
}

func (js *JobSched) findWaitingJobUnsafe() *Job {
	for i := range js.jobs {
		if js.jobs[i].Status == JobWaiting {
			return &js.jobs[i]
		}
	}
	return nil
}

// creates deep copy of job. Immutable fields are shallow copied.
func copyJobUnsafe(job Job) Job {
	newJob := Job{
		ID:        job.ID,
		Commands:  job.Commands,
		Signals:   job.Signals,
		Status:    job.Status,
		TimeAdded: job.TimeAdded,
	}
	if job.TimeStarted != nil {
		t := *job.TimeStarted
		newJob.TimeStarted = &t
	}
	if job.TimeEnded != nil {
		t := *job.TimeEnded
		newJob.TimeEnded = &t
	}
	return newJob
}

func (js *JobSched) keepSendingSignals(signal string, value float32, stop chan struct{}) {
	tick := time.Tick(time.Duration(value * float32(time.Second)))
	for {
		select {
		case <-stop:
			return
		case <-tick:
			js.commInstance.SendSignal(signal)
		}
	}
}

func (js *JobSched) keepExecutingJobs() {
	for {
		// Wait until a job become runnable.
		var job *Job
		for {
			job = func() *Job {
				js.mu.Lock()
				defer js.mu.Unlock()
				job := js.findWaitingJobUnsafe()
				if job != nil && js.commInstance.CommandQueueLength() == 0 {
					// Mark as started
					tStart := time.Now().Local()
					job.Status = JobRunning
					job.TimeStarted = &tStart
					return job
				}
				return nil
			}()
			if job != nil {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}

		// Execute
		stop := make(chan struct{})
		for signal, value := range job.Signals {
			go js.keepSendingSignals(signal, value, stop)
		}
		for _, command := range job.Commands {
			js.commInstance.WriteCommand(command)
		}

		// Wait job completion (== cmd queue become empty) or cancellation
		for {
			ended := func() bool {
				js.mu.Lock()
				defer js.mu.Unlock()
				if job.Status == JobCanceled {
					close(stop)
					js.commInstance.DrainCommandQueue()
					return true
				}
				if js.commInstance.CommandQueueLength() == 0 {
					close(stop)
					// Mark job as completed
					tEnd := time.Now().Local()
					job.Status = JobCompleted
					job.TimeEnded = &tEnd
					return true
				}
				return false
			}()
			if ended {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
}

func (js *JobSched) AddJob(commands []string, signals map[string]float32) (string, bool) {
	js.mu.Lock()
	defer js.mu.Unlock()

	if js.findPendingJobUnsafe() != nil || js.commInstance.CommandQueueLength() > 0 {
		return "", false
	}

	// Add new job
	job := Job{
		ID:        js.issueNewJobIDUnsafe(),
		Commands:  commands,
		Signals:   signals,
		Status:    JobWaiting,
		TimeAdded: time.Now().Local(),
	}
	js.jobs = append(js.jobs, job)
	return job.ID, true
}

func (js *JobSched) ListJobs() []Job {
	js.mu.Lock()
	defer js.mu.Unlock()

	jobs := make([]Job, len(js.jobs))
	for i, job := range js.jobs {
		jobs[i] = copyJobUnsafe(job)
	}
	return jobs
}

// Returns true if a job was canceled, false if no pending job exists.
// JobSched drains CommandQueue iff job was canceled.
func (js *JobSched) CancelJob() bool {
	js.mu.Lock()
	defer js.mu.Unlock()

	job := js.findPendingJobUnsafe()
	if job == nil {
		return false
	}

	job.Status = JobCanceled
	tEnd := time.Now().Local()
	job.TimeEnded = &tEnd
	return true
}

func (js *JobSched) HasPendingJob() bool {
	js.mu.Lock()
	defer js.mu.Unlock()

	return js.findPendingJobUnsafe() != nil
}

func (js *JobSched) FindRunningJobID() (string, bool) {
	js.mu.Lock()
	defer js.mu.Unlock()

	job := js.findRunningJobUnsafe()
	if job == nil {
		return "", false
	}
	return job.ID, true
}
