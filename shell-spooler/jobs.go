// SPDX-FileCopyrightText: 2025 夕月霞
// SPDX-License-Identifier: AGPL-3.0-or-later
package main

import (
	"fmt"
	"slices"
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
	JobFailed    JobStatus = "FAILED"
)

type Job struct {
	ID          string
	Commands    []string
	Polls       map[string]float32
	Status      JobStatus
	TimeAdded   time.Time
	TimeStarted *time.Time
	TimeEnded   *time.Time
}

// JobSched stores list of jobs and manage their execution.
// The active Comm is swapped per device session via SetComm; nil means "no live device".
// ~unsafe methods are not mutex-protected, caller must protect with mutex
type JobSched struct {
	mu        sync.Mutex
	jobs      []Job
	nextJobID int

	commInstance *comm.Comm
}

// InitJobSched creates and starts the scheduler. The scheduler idles until SetComm is called.
func InitJobSched() *JobSched {
	sched := &JobSched{
		nextJobID: 1,
	}
	go sched.keepExecutingJobs()
	return sched
}

// SetComm attaches (or detaches with nil) the active Comm. While nil, AddJob fails fast
// and the executor idles.
func (js *JobSched) SetComm(c *comm.Comm) {
	js.mu.Lock()
	defer js.mu.Unlock()
	js.commInstance = c
}

// FailRunningJobs marks every WAITING or RUNNING job as FAILED. Used when the device dies.
func (js *JobSched) FailRunningJobs() {
	js.mu.Lock()
	defer js.mu.Unlock()
	now := time.Now().Local()
	for i := range js.jobs {
		s := js.jobs[i].Status
		if s == JobWaiting || s == JobRunning {
			js.jobs[i].Status = JobFailed
			t := now
			js.jobs[i].TimeEnded = &t
		}
	}
}

func (js *JobSched) issueNewJobIDUnsafe() string {
	jobID := fmt.Sprintf("jb%d", js.nextJobID)
	js.nextJobID++
	return jobID
}

func (js *JobSched) findJobUnsafe(status []JobStatus) *Job {
	for i := range js.jobs {
		if slices.Contains(status, js.jobs[i].Status) {
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
		Polls:     job.Polls,
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

func keepSendingPolls(cm *comm.Comm, poll string, value float32, stop chan struct{}) {
	tick := time.Tick(time.Duration(value * float32(time.Second)))
	for {
		select {
		case <-stop:
			return
		case <-tick:
			cm.SendImmediate(poll)
		}
	}
}

func (js *JobSched) keepExecutingJobs() {
	for {
		// Wait until a job becomes runnable on a live Comm.
		var job *Job
		var cmAt *comm.Comm
		for {
			job, cmAt = func() (*Job, *comm.Comm) {
				js.mu.Lock()
				defer js.mu.Unlock()
				if js.commInstance == nil {
					return nil, nil
				}
				j := js.findJobUnsafe([]JobStatus{JobWaiting})
				if j != nil && js.commInstance.CommandQueueLength() == 0 {
					tStart := time.Now().Local()
					j.Status = JobRunning
					j.TimeStarted = &tStart
					return j, js.commInstance
				}
				return nil, nil
			}()
			if job != nil {
				break
			}
			time.Sleep(500 * time.Millisecond)
		}

		// Execute using the Comm captured at job-start; ignore later SetComm swaps.
		stop := make(chan struct{})
		for poll, value := range job.Polls {
			go keepSendingPolls(cmAt, poll, value, stop)
		}
		for _, command := range job.Commands {
			cmAt.WriteCommand(command)
		}

		// Wait for job completion (queue drained), cancellation, or device-death FAILED.
		for {
			ended := func() bool {
				js.mu.Lock()
				defer js.mu.Unlock()
				if job.Status == JobCanceled {
					close(stop)
					cmAt.DrainCommandQueue()
					return true
				}
				if job.Status == JobFailed {
					close(stop)
					return true
				}
				if cmAt.CommandQueueLength() == 0 {
					close(stop)
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

func (js *JobSched) AddJob(commands []string, polls map[string]float32) (string, bool) {
	js.mu.Lock()
	defer js.mu.Unlock()

	if js.commInstance == nil {
		return "", false
	}
	if js.findJobUnsafe([]JobStatus{JobWaiting, JobRunning}) != nil || js.commInstance.CommandQueueLength() > 0 {
		return "", false
	}

	job := Job{
		ID:        js.issueNewJobIDUnsafe(),
		Commands:  commands,
		Polls:     polls,
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

	job := js.findJobUnsafe([]JobStatus{JobWaiting, JobRunning})
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

	return js.findJobUnsafe([]JobStatus{JobWaiting, JobRunning}) != nil
}

func (js *JobSched) FindRunningJobID() (string, bool) {
	js.mu.Lock()
	defer js.mu.Unlock()

	job := js.findJobUnsafe([]JobStatus{JobRunning})
	if job == nil {
		return "", false
	}
	return job.ID, true
}
