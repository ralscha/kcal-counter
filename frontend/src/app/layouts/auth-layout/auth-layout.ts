import { NgOptimizedImage } from '@angular/common';
import { Component, ChangeDetectionStrategy } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-auth-layout',
  imports: [RouterOutlet, NgOptimizedImage],
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './auth-layout.html',
})
export class AuthLayoutComponent {}
