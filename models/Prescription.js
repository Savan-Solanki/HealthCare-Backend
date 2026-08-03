const mongoose = require("mongoose");

const medicineSchema = new mongoose.Schema(
  {
    medicineName: {
      type: String,
      required: [true, "Medicine name is required"],
      trim: true,
    },
    dosage: {
      type: String,
      required: [true, "Dosage is required"],
      trim: true,
    },
    frequency: {
      type: String,
      required: [true, "Frequency is required"],
      trim: true,
    },
    duration: {
      type: String,
      required: [true, "Duration is required"],
      trim: true,
    },
    schedule: {
      morning: {
        type: Boolean,
        default: false,
      },
      afternoon: {
        type: Boolean,
        default: false,
      },
      night: {
        type: Boolean,
        default: false,
      },
      morningTime: {
        type: String,
        trim: true,
        default: "",
      },
      afternoonTime: {
        type: String,
        trim: true,
        default: "",
      },
      nightTime: {
        type: String,
        trim: true,
        default: "",
      },
    },
  },
  { _id: false }
);

const prescriptionSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: ["doctor_generated", "patient_uploaded"],
      default: "doctor_generated",
      index: true,
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Hospital",
      required: [
        function requiredForDoctorPrescription() {
          return this.source !== "patient_uploaded";
        },
        "Hospital is required",
      ],
      default: null,
      index: true,
    },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      default: null,
      index: true,
    },
    doctorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [
        function requiredForDoctorPrescription() {
          return this.source !== "patient_uploaded";
        },
        "Doctor user is required",
      ],
      default: null,
      index: true,
    },
    patientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientUser",
      default: null,
      index: true,
    },
    uploadedByPatientUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PatientUser",
      default: null,
      index: true,
    },
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      default: null,
      index: true,
    },
    prescriptionNumber: {
      type: String,
      trim: true,
      default: "",
      index: true,
    },
    patientName: {
      type: String,
      required: [true, "Patient name is required"],
      trim: true,
    },
    patientAge: {
      type: Number,
      default: null,
    },
    patientGender: {
      type: String,
      trim: true,
      default: "",
    },
    patientMobile: {
      type: String,
      trim: true,
      default: "",
    },
    diagnosis: {
      type: String,
      required: [true, "Diagnosis is required"],
      trim: true,
    },
    prescriptionDate: {
      type: Date,
      required: [true, "Prescription date is required"],
    },
    followUpDate: {
      type: Date,
      default: null,
    },
    instruction: {
      type: String,
      trim: true,
      default: "",
    },
    doctorNotes: {
      type: String,
      trim: true,
      default: "",
    },
    doctorName: {
      type: String,
      trim: true,
      default: "",
    },
    doctorSpecialization: {
      type: String,
      trim: true,
      default: "",
    },
    doctorRegistrationNumber: {
      type: String,
      trim: true,
      default: "",
    },
    hospitalName: {
      type: String,
      trim: true,
      default: "",
    },
    hospitalAddress: {
      type: String,
      trim: true,
      default: "",
    },
    includemedikwikLogo: {
      type: Boolean,
      default: false,
    },
    medicines: {
      type: [medicineSchema],
      default: [],
      validate: {
        validator: function validateDoctorMedicines(value) {
          if (this.source === "patient_uploaded") return true;
          return Array.isArray(value) && value.length > 0;
        },
        message: "At least one medicine is required",
      },
    },
    document: {
      bucket: {
        type: String,
        trim: true,
        default: "",
      },
      key: {
        type: String,
        trim: true,
        default: "",
      },
      contentType: {
        type: String,
        trim: true,
        default: "application/pdf",
      },
      fileName: {
        type: String,
        trim: true,
        default: "",
      },
      size: {
        type: Number,
        min: 0,
        default: 0,
      },
      etag: {
        type: String,
        trim: true,
        default: "",
      },
      generatedAt: {
        type: Date,
        default: null,
      },
    },
    originalUpload: {
      fileName: {
        type: String,
        trim: true,
        default: "",
      },
      contentType: {
        type: String,
        trim: true,
        default: "",
      },
      size: {
        type: Number,
        min: 0,
        default: 0,
      },
      uploadedAt: {
        type: Date,
        default: null,
      },
    },
  },
  {
    timestamps: true,
  }
);

prescriptionSchema.index({ hospitalId: 1, doctorUserId: 1, prescriptionDate: -1 });
prescriptionSchema.index({ patientUserId: 1, prescriptionDate: -1 });
prescriptionSchema.index({ patientId: 1, prescriptionDate: -1 });
prescriptionSchema.index({ patientName: "text", diagnosis: "text", instruction: "text" });

module.exports = mongoose.model("Prescription", prescriptionSchema);
